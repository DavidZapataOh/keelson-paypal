import { mountStage } from "./rive-stage";

const stage = document.getElementById("problem-stage");
const canvas = document.getElementById("problem-rive") as HTMLCanvasElement | null;

if (stage && canvas) {
  mountStage({ stage, canvas, artboard: "Problem", stateMachine: "Story" });
}
