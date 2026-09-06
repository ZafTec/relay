"""Exercise the actual production site config over HTTP in isolated CI containers."""
from pathlib import Path
import sys

source = Path(__file__).resolve().parents[1] / "nginx" / "relay.conf"
sections = source.read_text().split("\nserver {")
assert len(sections) == 3, "Expected separate ACME/redirect and TLS servers"
site = "server {" + sections[2]
site = site.replace("listen 443 ssl;", "listen 8080;")
site = "\n".join(
    line for line in site.splitlines()
    if not line.strip().startswith(("listen [::]:443", "ssl_certificate", "http2 on;"))
)
config = (
    "pid /tmp/nginx.pid;\nerror_log stderr notice;\nevents {}\nhttp {\n"
    "include /etc/nginx/mime.types;\n" + sections[0] + "\n" + site + "\n"
)
# Exercise the bucket location within the existing storage host separately.
# Its upstream uses Docker DNS at request time so bootstrap needs no MinIO.
storage = source.with_name("storage-relay-location.conf.example").read_text()
storage = storage.replace("proxy_pass http://minio:9000;", "proxy_pass http://$storage_upstream;")
config += (
    "server { listen 8081; server_name storage.zaftech.co;\n"
    "resolver 127.0.0.11 valid=10s ipv6=off;\n"
    "set $storage_upstream minio:9000;\n" + storage + "\n}\n}\n"
)
Path(sys.argv[1]).write_text(config)
