// Test-only OTLP receiver and probe. No real collector or provider is contacted.
const signals = ["logs", "metrics", "traces"] as const;
const services = ["relay-api", "relay-worker"] as const;
type Signal = typeof signals[number];
const seen = new Map<string, Set<Signal>>();
const names = new Set<string>();
const expectedNames = [
  "relay.http.server.request.duration",
  "relay.worker.heartbeats",
  "worker.started",
];

if (Deno.args[0] === "serve") {
  Deno.serve({ hostname: "0.0.0.0", port: 4318 }, async (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/status") {
      return Response.json({
        services: Object.fromEntries([...seen].map(([key, value]) => [
          key,
          [...value],
        ])),
        names: [...names],
      });
    }
    const signal = signals.find((name) => path === `/v1/${name}`);
    if (request.method !== "POST" || !signal) {
      return new Response(null, { status: 404 });
    }
    // Protobuf string fields retain their UTF-8 bytes. We need only prove that
    // the actual compiled processes exported their signals and instruments.
    const payload = new TextDecoder().decode(await request.arrayBuffer());
    for (const service of services) {
      if (payload.includes(service)) {
        const accepted = seen.get(service) ?? new Set<Signal>();
        accepted.add(signal);
        seen.set(service, accepted);
      }
    }
    for (const name of expectedNames) {
      if (payload.includes(name)) names.add(name);
    }
    return new Response(new Uint8Array(), {
      headers: { "content-type": "application/x-protobuf" },
    });
  });
} else {
  const endpoint = Deno.env.get("RELAY_TEST_OTLP_ENDPOINT") ??
    "http://telemetry:4318";
  const deadline = Date.now() + 45_000;
  let status: {
    services: Record<string, string[]>;
    names: string[];
  } | undefined;
  do {
    const response = await fetch(`${endpoint}/status`);
    if (!response.ok) throw new Error("Test telemetry receiver unavailable");
    status = await response.json();
    if (
      services.every((service) =>
        signals.every((signal) => status?.services[service]?.includes(signal))
      ) && expectedNames.every((name) => status?.names.includes(name))
    ) {
      console.log(
        "Compiled API and worker exported logs, metrics, and traces.",
      );
      Deno.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } while (Date.now() < deadline);
  throw new Error(
    `Compiled telemetry export incomplete: ${JSON.stringify(status)}`,
  );
}
