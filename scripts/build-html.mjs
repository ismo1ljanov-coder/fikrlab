// web/index.html ni JS modulga aylantiradi: serverless funksiyaga fayl sifatida qo‘shilishi kafolatlanadi
import fs from "node:fs";
const html = fs.readFileSync(new URL("../web/index.html", import.meta.url), "utf8");
fs.writeFileSync(new URL("../web/index-html.mjs", import.meta.url), "export default " + JSON.stringify(html) + ";\n");
console.log("web/index-html.mjs tayyor:", html.length, "belgi");
