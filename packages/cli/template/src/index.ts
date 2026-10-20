import { start } from "@elysiax/core";
import "./app.layout";
import * as gen from "../.elysiax";

await start({ port: 3000, gen });
