# TCPS certificates on Windows

Acid uses `node-oracledb` Thin mode. It does not read the JDK truststore. Node.js validates the Oracle server certificate using its own trusted CAs, the Windows certificate store when enabled, or a PEM CA bundle supplied at process startup.

## TNS configuration

A TCPS alias can disable hostname/DN matching when the server is trusted but its certificate does not contain the TNS host name:

```text
PROD_TCPS =
  (DESCRIPTION =
    (ADDRESS =
      (PROTOCOL = TCPS)
      (HOST = secure-db.example.internal)
      (PORT = 2484)
    )
    (CONNECT_DATA =
      (SERVICE_NAME = APPPDB1)
    )
    (SECURITY =
      (SSL_SERVER_DN_MATCH = NO)
    )
  )
```

`SSL_SERVER_DN_MATCH=NO` disables hostname/DN matching. It does not disable certificate-chain validation, expiration checks, or other TLS validation.

## Trusting three PEM certificates

First confirm that all three files contain certificates and not private keys:

```powershell
Select-String -Path C:\certs\*.pem -Pattern "BEGIN "
```

Certificate files contain:

```text
-----BEGIN CERTIFICATE-----
```

Do not put files containing `BEGIN PRIVATE KEY`, `BEGIN ENCRYPTED PRIVATE KEY`, or `BEGIN RSA PRIVATE KEY` into the CA bundle.

Combine the three certificate files into one ASCII PEM bundle:

```powershell
$certDir = "C:\certs"
$bundle = "$certDir\oracle-ca-chain.pem"

Get-ChildItem "$certDir\*.pem" |
  Where-Object FullName -ne $bundle |
  ForEach-Object {
    Get-Content $_.FullName
    ""
  } |
  Set-Content $bundle -Encoding ascii
```

Verify that the resulting bundle contains three certificates:

```powershell
(Select-String -Path $bundle -Pattern "BEGIN CERTIFICATE").Count
```

Expected output:

```text
3
```

Stop the currently running Acid process. Set the CA bundle in the same PowerShell session and start Acid with portable Node 24:

```powershell
$env:NODE_EXTRA_CA_CERTS = $bundle
& $node dist\server\index.js
```

`NODE_EXTRA_CA_CERTS` is read only when Node starts. Changing it does not affect an already-running process.

## Using the Windows certificate store

Node 24 can additionally use certificates trusted by Windows:

```powershell
$env:NODE_OPTIONS = "--use-system-ca"
& $node dist\server\index.js
```

`NODE_OPTIONS=--use-system-ca` and `NODE_EXTRA_CA_CERTS` can be used together.

## Mutual TLS wallets

For mutual TLS, configure `walletLocation` in `config.yaml`:

```yaml
connections:
  secure-production:
    type: oracle
    tnsAlias: PROD_TCPS
    tnsAdmin: C:/Oracle/network/admin
    walletLocation: C:/Oracle/wallet
    walletPasswordEnv: ACID_TRIP_WALLET_PASSWORD
    username: app_user
    passwordEnv: ACID_TRIP_PROD_PASSWORD
```

In Thin mode, `walletLocation` must contain a file named exactly:

```text
ewallet.pem
```

The wallet normally includes the client private key, client certificate, and trusted certificate chain. Do not use a PEM containing private keys as `NODE_EXTRA_CA_CERTS`.

## Troubleshooting

- **Host not present in certificate:** use the hostname from the certificate, or set `SSL_SERVER_DN_MATCH=NO`.
- **Self-signed certificate in certificate chain:** add the root, intermediate, and self-signed leaf certificate as needed to `NODE_EXTRA_CA_CERTS`.
- **TNS alias not found:** ensure `tnsAdmin` points to a directory containing a file named exactly `tnsnames.ora`.
- **NJS-514:** validate the TNS file with:

  ```powershell
  & $node -e "const o=require('oracledb'); o.getNetworkServiceNames('C:/Oracle/network/admin').then(console.log).catch(console.error)"
  ```

- Restart Acid after changing TNS files, certificate variables, or connection configuration.
