//go:build integration

package integration

import (
	"context"
	"fmt"
	"io"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

// restartablePG is a disposable PostgreSQL container behind a TCP forwarder on a
// fixed local address. The container's published port changes when it is
// restarted; the forwarder resolves it for every new connection, so the
// connection string the cloud was started with stays valid across Stop/Start,
// exactly like a service name in front of a restarted database.
type restartablePG struct {
	ctr  testcontainers.Container
	URL  string
	l    net.Listener
	mu   sync.Mutex
	open map[net.Conn]struct{}
}

func startRestartablePG(t *testing.T) *restartablePG {
	t.Helper()
	ctx := context.Background()
	ctr, err := tcpostgres.Run(ctx, "postgres:17",
		tcpostgres.WithDatabase("nodus"), tcpostgres.WithUsername("nodus"), tcpostgres.WithPassword("nodus"),
		testcontainers.WithWaitStrategy(wait.ForLog("database system is ready to accept connections").WithOccurrence(2).WithStartupTimeout(60*time.Second)),
	)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ctr.Terminate(context.Background()) })
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &restartablePG{ctr: ctr, l: l, open: map[net.Conn]struct{}{}, URL: fmt.Sprintf("postgres://nodus:nodus@%s/nodus?sslmode=disable", l.Addr())}
	go p.serve()
	t.Cleanup(func() { _ = l.Close(); p.dropAll() })
	return p
}

func (p *restartablePG) serve() {
	for {
		c, err := p.l.Accept()
		if err != nil {
			return
		}
		go p.forward(c)
	}
}

func (p *restartablePG) forward(c net.Conn) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	host, err := p.ctr.Host(ctx)
	if err != nil {
		_ = c.Close()
		return
	}
	port, err := p.ctr.MappedPort(ctx, "5432/tcp")
	if err != nil {
		_ = c.Close()
		return
	}
	up, err := net.DialTimeout("tcp", net.JoinHostPort(host, port.Port()), 2*time.Second)
	if err != nil {
		_ = c.Close()
		return
	}
	p.mu.Lock()
	p.open[c], p.open[up] = struct{}{}, struct{}{}
	p.mu.Unlock()
	go func() { _, _ = io.Copy(up, c); _ = up.Close() }()
	_, _ = io.Copy(c, up)
	_ = c.Close()
}

// dropAll closes every proxied connection (a database going away drops its sockets).
func (p *restartablePG) dropAll() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for c := range p.open {
		_ = c.Close()
	}
	p.open = map[net.Conn]struct{}{}
}

func (p *restartablePG) stop(t *testing.T) {
	t.Helper()
	d := 10 * time.Second
	if err := p.ctr.Stop(context.Background(), &d); err != nil {
		t.Fatal(err)
	}
	p.dropAll()
}

func (p *restartablePG) start(t *testing.T) {
	t.Helper()
	if err := p.ctr.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
}
