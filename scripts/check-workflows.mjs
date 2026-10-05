import fs from "node:fs";
import YAML from "yaml";
const files=fs.readdirSync("user-tools").filter(x=>x.endsWith(".yaml"));
if(files.length!==20)throw new Error("expected 20 user tools, got "+files.length);
for(const file of files){const x=YAML.parse(fs.readFileSync("user-tools/"+file,"utf8"));if(!x.graph?.length||!x.completion?.require?.length)throw new Error("invalid workflow "+file);}
console.log("20 user-tool workflow specs valid");
