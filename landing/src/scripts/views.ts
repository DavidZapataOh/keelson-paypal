import { mountStage } from "./rive-stage";

const stage = document.getElementById("views-stage");
const canvas = stage?.querySelector("canvas");

// the three windows side by side need width; below 1180px the scene would be too small to read, so the HTML windows stay
if (stage && canvas && matchMedia("(min-width: 1180px)").matches) {
  mountStage({ stage, canvas, artboard: "Views", stateMachine: "Loop" });
}
