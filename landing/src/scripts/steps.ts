import { mountStage } from "./rive-stage";

for (const stage of document.querySelectorAll<HTMLElement>(".fig-stage[data-artboard]")) {
  const canvas = stage.querySelector("canvas");
  if (canvas) {
    mountStage({ stage, canvas, artboard: stage.dataset.artboard ?? "", stateMachine: "Loop" });
  }
}
