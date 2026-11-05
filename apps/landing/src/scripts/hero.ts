import { mountStage } from "./rive-stage";

const stage = document.getElementById("hero-stage");
const canvas = document.getElementById("hero-rive") as HTMLCanvasElement | null;

if (stage && canvas) {
  mountStage({
    stage,
    canvas,
    artboard: "Hero",
    narrowArtboard: "HeroMobile",
    stateMachine: "Checkout",
    flag: "attacked",
    hold: { off: 6200, on: 8200 },
    live: document.getElementById("hero-live"),
    captions: {
      off: "An agent checks out under a mandate of shoes, size 10, at most 100 dollars. Keelson countersigns the 94 dollar cart and it is paid.",
      on: "A page pushes a 340 dollar bundle and the agent adds it. Keelson finds the total above the 100 dollar mandate and blocks the order. Nothing is paid.",
    },
  });
}
