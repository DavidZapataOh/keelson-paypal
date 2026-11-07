import { defineRailway, image, preserve, project, service, volume } from "railway/iac";

const IMAGE =
  "ghcr.io/davidzapataoh/keelson-witness@sha256:bb2569fe652c17ab91a7216336d4b7c5e1d8670ddee3bc59069df7efeb7bb28c";

export default defineRailway(() => {
  const data = volume("witness-2-data", { region: "us-west2", sizeMB: 1024 });
  const witness = service("keelson-witness-2", {
    source: image(IMAGE),
    replicas: { "us-west2": 1 },
    healthcheck: "/",
    volumeMounts: { "/data": data },
    domains: [{ domain: "witness-2.keelson.finance", port: 7380 }],
    env: {
      WITNESS_NAME: "witness-2.keelson.finance",
      WITNESS_KEY: preserve(),
      DB: "/data/litewitness.db",
      PORT: "7380",
    },
  });
  return project("keelson-witness-2", { resources: [witness, data] });
});
