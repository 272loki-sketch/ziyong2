import { readFileSync, writeFileSync } from "node:fs";
const path = "test/novel-play-adversarial.test.ts";
let value = readFileSync(path, "utf8");
const old = `function makeHost(cwd:string,runSideText:RestHost["runSideText"],overrides:Partial<RestHost>={}){let sessionId="session-a",runtimeCard=defaultCard;return {cwd,isStreaming:()=>false,runSideText,memoryScope:()=>({sessionId,card:runtimeCard}),switchToCard:async()=>{runtimeCard=JSON.parse(readFileSync(join(cwd,"liyuan.config.json"),"utf8")).card;sessionId="created-session";return "created"},...overrides} as RestHost}`;
const next = `function makeHost(cwd:string,runSideText:RestHost["runSideText"],overrides:Partial<RestHost>={}){let sessionId="session-a",runtimeCard=defaultCard;const memoryScope=overrides.memoryScope??(()=>({sessionId,card:runtimeCard}));const suppliedSwitch=overrides.switchToCard;return {cwd,isStreaming:()=>false,runSideText,...overrides,memoryScope,switchToCard:async()=>{const result=suppliedSwitch?await suppliedSwitch():"created";if(result==="created"){runtimeCard=JSON.parse(readFileSync(join(cwd,"liyuan.config.json"),"utf8")).card;sessionId="created-session"}return result}} as RestHost}`;
if (!value.includes(old)) throw new Error("adversarial host fixture changed");
writeFileSync(path, value.replace(old, next));
