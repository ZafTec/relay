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
    "include /etc/nginx/mime.types;\n" + sections[0] + "\n" + site + "\n}\n"
)
Path(sys.argv[1]).write_text(config)
