package vaultcrypto

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// Blob format (§3.8.3):
//
//	header: "NDS1" | version (1 B) | salt_file (16 B) | chunk_size (4 B, big endian)
//	body:   chunk_0 ‖ chunk_1 ‖ … (each: ciphertext ‖ 16-byte GCM tag)
//	nonce:  96-bit big-endian counter = chunk index
//	AAD:    vault_id (16 B) ‖ file_id (16 B) ‖ chunk index (8 B big endian) ‖ last-chunk flag (1 B)
//
// chunk_size is the plaintext size of every chunk but the last, which holds
// 1..chunk_size bytes (an empty file is a single empty chunk). Reading ahead
// one chunk tells the encryptor which chunk is last, so truncation is
// detected by the flag in the AAD.
const (
	Magic            = "NDS1"
	FormatVersion    = 1
	DefaultChunkSize = 64 * 1024
	headerSize       = 4 + 1 + SaltSize + 4
	maxChunkSize     = 16 * 1024 * 1024
)

// ErrFormat means the data is not a valid NDS1 blob.
var ErrFormat = errors.New("vaultcrypto: not an NDS1 blob")

func chunkAAD(vaultID, fileID [16]byte, index uint64, last bool) []byte {
	aad := make([]byte, 0, 41)
	aad = append(aad, vaultID[:]...)
	aad = append(aad, fileID[:]...)
	aad = binary.BigEndian.AppendUint64(aad, index)
	if last {
		return append(aad, 1)
	}
	return append(aad, 0)
}

func chunkNonce(index uint64) []byte {
	n := make([]byte, NonceSize)
	binary.BigEndian.PutUint64(n[4:], index)
	return n
}

// EncryptBlob encrypts r to w with a fresh salt and the default chunk size.
func EncryptBlob(w io.Writer, r io.Reader, s Subkeys, vaultID, fileID [16]byte) error {
	var salt [SaltSize]byte
	if _, err := rand.Read(salt[:]); err != nil {
		return err
	}
	return EncryptBlobWith(w, r, s, vaultID, fileID, salt, DefaultChunkSize)
}

// EncryptBlobWith is EncryptBlob with explicit salt and chunk size (vectors, tests).
func EncryptBlobWith(w io.Writer, r io.Reader, s Subkeys, vaultID, fileID [16]byte, salt [SaltSize]byte, chunkSize int) error {
	if chunkSize <= 0 || chunkSize > maxChunkSize {
		return fmt.Errorf("vaultcrypto: invalid chunk size %d", chunkSize)
	}
	key := s.FileKey(fileID, salt)
	g, err := newGCM(key[:])
	if err != nil {
		return err
	}
	hdr := make([]byte, 0, headerSize)
	hdr = append(hdr, Magic...)
	hdr = append(hdr, FormatVersion)
	hdr = append(hdr, salt[:]...)
	hdr = binary.BigEndian.AppendUint32(hdr, uint32(chunkSize))
	if _, err := w.Write(hdr); err != nil {
		return err
	}

	cur := make([]byte, chunkSize)
	next := make([]byte, chunkSize)
	n, err := io.ReadFull(r, cur)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return err
	}
	last := n < chunkSize
	for index := uint64(0); ; index++ {
		var nn int
		if !last {
			nn, err = io.ReadFull(r, next)
			if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
				return err
			}
			if nn == 0 { // the chunk just read was the last one
				last = true
			}
		}
		sealed := g.Seal(nil, chunkNonce(index), cur[:n], chunkAAD(vaultID, fileID, index, last))
		if _, err := w.Write(sealed); err != nil {
			return err
		}
		if last {
			return nil
		}
		cur, next = next, cur
		n = nn
		last = nn < chunkSize
	}
}

// DecryptBlob authenticates and decrypts an NDS1 blob into w. Output may
// already have been written when an error is returned: callers writing files
// must use a temporary and discard it on error.
func DecryptBlob(w io.Writer, r io.Reader, s Subkeys, vaultID, fileID [16]byte) error {
	hdr := make([]byte, headerSize)
	if _, err := io.ReadFull(r, hdr); err != nil {
		return ErrFormat
	}
	if string(hdr[:4]) != Magic || hdr[4] != FormatVersion {
		return ErrFormat
	}
	var salt [SaltSize]byte
	copy(salt[:], hdr[5:5+SaltSize])
	chunkSize := int(binary.BigEndian.Uint32(hdr[5+SaltSize:]))
	if chunkSize <= 0 || chunkSize > maxChunkSize {
		return ErrFormat
	}
	key := s.FileKey(fileID, salt)
	g, err := newGCM(key[:])
	if err != nil {
		return err
	}
	size := chunkSize + TagSize
	cur := make([]byte, size)
	next := make([]byte, size)
	n, err := io.ReadFull(r, cur)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return err
	}
	if n < TagSize {
		return ErrFormat // at least one (possibly empty) chunk is required
	}
	last := n < size
	for index := uint64(0); ; index++ {
		var nn int
		if !last {
			nn, err = io.ReadFull(r, next)
			if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
				return err
			}
			if nn == 0 {
				last = true
			}
		}
		pt, err := g.Open(nil, chunkNonce(index), cur[:n], chunkAAD(vaultID, fileID, index, last))
		if err != nil {
			return ErrDecrypt
		}
		if _, err := w.Write(pt); err != nil {
			return err
		}
		if last {
			return nil
		}
		if nn < TagSize {
			return ErrFormat
		}
		cur, next = next, cur
		n = nn
		last = nn < size
	}
}

// Encrypt and Decrypt are in-memory conveniences for small payloads.
func Encrypt(s Subkeys, vaultID, fileID [16]byte, plaintext []byte) ([]byte, error) {
	var buf bytes.Buffer
	if err := EncryptBlob(&buf, bytes.NewReader(plaintext), s, vaultID, fileID); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// Decrypt reverses Encrypt.
func Decrypt(s Subkeys, vaultID, fileID [16]byte, blob []byte) ([]byte, error) {
	var buf bytes.Buffer
	if err := DecryptBlob(&buf, bytes.NewReader(blob), s, vaultID, fileID); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// EncryptedSize returns the exact size of the NDS1 blob for n plaintext bytes.
func EncryptedSize(n int64, chunkSize int) int64 {
	chunks := max(1, (n+int64(chunkSize)-1)/int64(chunkSize))
	return headerSize + n + chunks*TagSize
}
