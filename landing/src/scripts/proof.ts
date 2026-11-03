import { mountStage } from "./rive-stage";

const stage = document.getElementById("proof-stage");
const canvas = document.getElementById("proof-rive") as HTMLCanvasElement | null;

if (stage && canvas) {
  mountStage({
    stage,
    canvas,
    artboard: "Proof",
    stateMachine: "Proof",
    flag: "forged",
    hold: { off: 4200, on: 7600 },
    live: document.getElementById("proof-live"),
    captions: {
      off: "The order's record verifies: its root matches the checkpoint published on-chain.",
      on: "The log's operator rewrites entry 1203 to say the user approved 340 dollars and re-signs it. The signature still checks out, but the computed root no longer matches the published checkpoint. Rewrite detected.",
    },
  });
}
