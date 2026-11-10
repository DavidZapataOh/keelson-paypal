import type { AgBaseRegistry, AgBaseWidgetDefinition, AgDefaultWidgetDefinition } from "ag-studio";
import type { DisputeDef } from "./dispute-widget";
import type { MatrixDef } from "./matrix-widget";

/** Studio's widgets plus the console's own two. */
export interface Registry extends AgBaseRegistry {
  widgets: readonly (
    | AgDefaultWidgetDefinition
    | AgBaseWidgetDefinition<"field-attribution-matrix", MatrixDef>
    | AgBaseWidgetDefinition<"dispute-clock", DisputeDef>
  )[];
}
