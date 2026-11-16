import { start } from "@elysiax/core";
import "./app.layout";
import * as gen from "../.elysiax";

const root = gen.buildRootContainer();
await start({ port: 3111, gen, root });
