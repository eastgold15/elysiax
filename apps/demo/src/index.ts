import index from "./index.html";
import { start } from "@elysiax/core";
import * as gen from "../.elysiax";

await start({ port: 3111, index, gen });
