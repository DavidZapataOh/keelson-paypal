import { defineRailway, project, service, volume } from "railway/iac";

// The code is deployed with `railway up` from the repository root; the
// Railway-provided domain is generated once with `railway domain`.
export default defineRailway(() => {
  const data = volume("monitor-data", { region: "us-west2", sizeMB: 1024 });
  const monitor = service("keelson-monitor", {
    replicas: { "us-west2": 1 },
    healthcheck: "/report",
    volumeMounts: { "/data": data },
    env: {
      RAILWAY_DOCKERFILE_PATH: "services/monitor/Dockerfile",
      // The distroless nonroot user cannot write to a Railway volume.
      RAILWAY_RUN_UID: "0",
      MONITOR_DATA_DIR: "/data",
      MONITOR_CLIENT_IP_HEADER: "X-Real-IP",
      PORT: "8080",
    },
  });
  return project("keelson-monitor", { resources: [monitor, data] });
});
