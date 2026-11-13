# Test di carico

`services/cloud/test/integration/load_test.go` (`CLARAE_LOAD=1 task test-load`) misura i criteri di uscita M2 contro uno stack locale (PostgreSQL in container, storage su filesystem): p95 di `GET /changes` < 200 ms e p95 di un `commit` da 50 operazioni < 500 ms, con 8 client concorrenti su un vault da 5.000 file.

`sync.k6.js` è la stessa misura contro un server già in esecuzione (staging, `task dev-cloud`):

```sh
k6 run -e BASE_URL=http://127.0.0.1:18081 -e TOKEN=<access token> -e VAULT_ID=<uuid> -e DEVICE_ID=<uuid> sync.k6.js
```
