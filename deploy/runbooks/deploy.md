# Deploy

Wait for the GitHub release to finish publishing both backend and web images.
Take a database backup before a schema change and keep it under the existing
backup procedure, using `/opt/relay/backups` if a local copy is needed.

```sh
cd /opt/relay
docker compose config --quiet
deploy
docker compose ps -a
curl --fail https://relay.zaftech.co/health/ready
curl --fail https://relay.zaftech.co/version
```

The alias pulls the released `latest` images and starts migration, API, worker
and web in dependency order. The three backend services read the same `.env`.
The images provide their own release version/revision and healthchecks.

If migration fails, inspect `docker compose logs relay-migrate` and resolve it
before starting the application. Check worker heartbeats, backend traces/logs,
and browser Faro events. Verify sign-in and a small artifact transfer. Do not
run paid tools without an explicit allowance.

Editing only images or `.env` does not need a Nginx reload. After changing the
single Nginx site file:

```sh
docker exec nginx nginx -t && docker exec nginx nginx -s reload
```
