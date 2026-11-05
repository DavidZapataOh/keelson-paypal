import { mountStage } from "./rive-stage";

const stage = document.getElementById("closing-stage");
const canvas = stage?.querySelector("canvas");

if (stage && canvas) {
  mountStage({ stage, canvas, artboard: "Closing", stateMachine: "Once" });
}
