import { defineModule } from "@elysiax/core";
import { CanvasRepository } from "./canvas.repository";
import { CanvasService } from "./canvas.service";

export default defineModule({
  provides: {
    canvasRepository: { class: CanvasRepository, deps: ["db"] },
    canvasService: { class: CanvasService, deps: ["canvasRepository"] },
  },
});
