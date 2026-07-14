# Acid

A local-first Oracle web notebook and database client. Acid provides a dense sidebar, CodeMirror SQL editing and IntelliSense, inline results, editable rows, transactions, and reusable positional SQL templates.

## Requirements

- Node.js 20+
- macOS or Windows
- Oracle Database reachable over TCP, TNS, or TCPS/wallet

Acid uses `node-oracledb` Thin mode, so Oracle Instant Client is not normally required.

## Install and run

```sh
npm install
npm run acid-trip:init   # create ~/.dbc/config.yaml if needed
npm run dev              # API :4174, Vite UI :4173
```

Open `http://127.0.0.1:4173`. For a production build:

```sh
npm run build
npm start                # UI and API at http://127.0.0.1:4174
```

The server binds only to `127.0.0.1` by default. Acid first loads `config.yaml` from the directory where it is launched. If that file is absent, it falls back to `~/.dbc/config.yaml`. Notebooks and templates remain under `~/.dbc`. `ACID_TRIP_CONFIG` can optionally point to a specific config file.

## Local Oracle XE test database

The repository includes an Oracle XE 21 Slim container and repeatable test schema. On Apple Silicon, XE runs through amd64 emulation and starts more slowly than a native image.

```sh
npm run oracle:up
# Wait until `docker compose ps` reports healthy
npm run oracle:smoke
```

Test connection:

```text
host:     127.0.0.1
port:     1521
service:  XEPDB1
username: dbc
password: dbc_test_123
```

Copy `config.example.yaml` to `config.yaml` in the project directory, then set the password and launch the client:

```sh
export DBC_XE_PASSWORD=dbc_test_123       # PowerShell: $env:DBC_XE_PASSWORD="dbc_test_123"
npm run dev
```

The `DBC` schema contains:

- `PROPERTIES` — four sample application properties
- `PROPERTY_AUDIT` — populated by a trigger when property values change
- `DOCUMENTS` — sample CLOB and BLOB columns for inspector and upload testing

Useful lifecycle commands:

```sh
npm run oracle:down   # stop and preserve data
npm run oracle:reset  # delete data and recreate the test schema
```

The credentials are intentionally local test credentials and must not be reused outside this container.

## Connection configuration

Complete standalone examples are checked in under `examples/connections/`:

- `regular.yaml` — direct host/port/service connection
- `tns.yaml` — TCP connection using a TNS alias
- `tcps.yaml` — TCPS connection with server trust or mutual TLS
- `tnsnames.ora` — matching TCP and TCPS aliases (the filename must remain exact)

See [`docs/tcps-certificates.md`](docs/tcps-certificates.md) for Windows trust configuration, PEM bundles, hostname matching, and mutual TLS wallets.

Use an example directly by copying it to `config.yaml` in the project directory and replacing its paths and environment-variable names.


Host, port, and service:

```yaml
defaultConnection: dev
fetchLimit: 100
connections:
  dev:
    type: oracle
    host: db.example.com
    port: 1521
    service: ORCLPDB1
    username: app
    passwordEnv: DBC_DEV_PASSWORD
```

SID:

```yaml
  legacy:
    type: oracle
    host: legacy.example.com
    port: 1521
    sid: ORCL
    username: app
    passwordEnv: DBC_LEGACY_PASSWORD
```

TNS or wallet:

```yaml
  secure:
    type: oracle
    tnsAlias: securedb_high
    tnsAdmin: /path/to/network/admin
    walletLocation: /path/to/wallet
    walletPasswordEnv: DBC_WALLET_PASSWORD
    username: app
    passwordEnv: DBC_SECURE_PASSWORD
```

Literal `password` and `walletPassword` values are supported for convenience but environment variables are preferred. Wallet-based external authentication can set `externalAuth: true` and omit the database password.

## Use

Choose a connection in the sidebar, enter SQL in a notebook cell, and run it with `Cmd/Ctrl+Enter`. Transaction controls are always visible in the header. Named notebooks are stored under `~/.dbc/notebooks`, autosaved, and can be opened, renamed, duplicated, or deleted from the sidebar.

Simple single-table results containing their primary key can be switched into edit mode; Apply uses bound updates and respects autocommit. Use the ⧉ row action to stage a duplicate. Identity columns are generated automatically, while manually assigned primary keys must be entered before Apply.

CLOB and BLOB cells appear as compact chips. Open a chip to inspect, edit/download CLOB text, preview recognized images and PDFs, or replace content from a file. Files can also be dropped directly onto a LOB cell. Replacements remain staged until Apply.

Multiple configured connections can remain open and retain independent transaction state.

### SQL templates

```text
/template save prop select * from properties where name like '%{1}%'
prop com.sample.property1
```

Arguments with spaces can be quoted. `{1}`, `{2}`, and so on are textual substitutions, intentionally matching the saved SQL syntax. Treat templates as trusted personal SQL rather than a bind-variable security boundary.

### Completion and IntelliSense

CodeMirror completion uses cached Oracle table and column metadata. Open completion with `Ctrl+Space`; tables and columns are also suggested while typing. The sidebar exposes the same catalog and primary-key metadata.

## Architecture

- `src/core`: UI-independent application, sessions, configuration, and templates
- `src/db`: swappable database adapter interface and Oracle implementation
- `src/server`: local Fastify API and static web server
- `web/src`: React notebook, CodeMirror editor, sidebar, and result grid
- `src/ui/ink`: retained legacy terminal UI

Database connections and transactions remain UI-independent. The web server addresses sessions by connection name, so notebook cells do not depend on global UI state.
