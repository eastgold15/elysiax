import { start } from "@elysiax/core";
import "./app.layout";
import * as gen from "@gen";

const root = gen.buildRootContainer();
await start({ port: 3000, gen, root });
