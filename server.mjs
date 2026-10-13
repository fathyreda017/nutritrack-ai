import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT || 3000);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const ROOT = path.resolve(".");

const server = http.createServer(async (req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "same-origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "X-Content-Type-Options": "nosniff"
  };
  for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  if (req.url === "/api/health" && req.method === "GET") {
    res.writeHead(200, {"Content-Type":"application/json; charset=utf-8"});
    return res.end(JSON.stringify({ok:true, aiConfigured:Boolean(OPENAI_API_KEY), model:MODEL}));
  }

  if (req.url === "/api/analyze-meal" && req.method === "POST") {
    if (!OPENAI_API_KEY) {
      res.writeHead(503, {"Content-Type":"application/json; charset=utf-8"});
      return res.end(JSON.stringify({error:"مفتاح OPENAI_API_KEY غير مضبوط على الخادم"}));
    }
    let body = "";
    req.on("data", chunk => { body += chunk; if (body.length > 20000) req.destroy(); });
    req.on("end", async () => {
      try {
        const parsed = JSON.parse(body || "{}");
        const mealText = String(parsed.mealText || "").trim().slice(0, 3000);
        const mealType = String(parsed.mealType || "وجبة").slice(0, 50);
        if (!mealText) throw new Error("اكتب تفاصيل الوجبة أولًا");

        const instructions = `أنت مساعد تقدير تغذية. حلّل وصف وجبة مكتوب بالعربية، مع مراعاة الأكلات المصرية. أعد JSON فقط، بلا markdown، بالشكل:
{"items":[{"name":"اسم الطعام","grams":150,"calories":250,"protein_g":25,"carbs_g":10,"fat_g":8,"assumption":"مثال: مشوي دون زيت إضافي"}],"confidence":"منخفض/متوسط/مرتفع","note":"ملاحظة قصيرة بالعربية"}
قدّر كل عنصر على حدة حسب الكمية المذكورة. لا تخترع دقة زائفة؛ إذا كانت الكمية أو الوصفة غير واضحة، اذكر افتراضك وخفّض مستوى الثقة. افصل الزيت/السمن أو الصوص إذا ذُكر، ولا تفترض كمية زيت غير معروفة كأنها مؤكدة؛ اذكر افتراضًا معقولًا. استخدم السعرات والماكروز المتوافقة قدر الإمكان (بروتين 4 kcal/g، كربوهيدرات 4، دهون 9) مع السماح بالتقريب والألياف. لو قال المستخدم "رغيف" قدّر الوزن المعتاد ووضّح الافتراض. لا تقدّم نصائح طبية أو تشخيصًا.`;

        const apiResponse = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: MODEL,
            store: false,
            instructions,
            input: `نوع الوجبة: ${mealType}\nوصف الطعام: ${mealText}`,
            max_output_tokens: 1200
          })
        });
        const result = await apiResponse.json();
        if (!apiResponse.ok) {
          const msg = result?.error?.message || "فشل طلب الذكاء الاصطناعي";
          res.writeHead(apiResponse.status, {"Content-Type":"application/json; charset=utf-8"});
          return res.end(JSON.stringify({error:msg}));
        }
        const output = (result.output || [])
          .filter(item => item.type === "message")
          .flatMap(item => item.content || [])
          .filter(c => c.type === "output_text")
          .map(c => c.text)
          .join("\n");
        let data;
        try {
          const clean = output.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
          data = JSON.parse(clean);
        } catch {
          throw new Error("لم أستطع قراءة نتيجة النموذج كبيانات منظمة");
        }
        if (!Array.isArray(data.items)) throw new Error("صيغة النتيجة غير مكتملة");
        data.items = data.items.map(x => ({
          name: String(x.name || "طعام").slice(0,120),
          grams: Math.max(0, Number(x.grams) || 0),
          calories: Math.max(0, Number(x.calories) || 0),
          protein_g: Math.max(0, Number(x.protein_g) || 0),
          carbs_g: Math.max(0, Number(x.carbs_g) || 0),
          fat_g: Math.max(0, Number(x.fat_g) || 0),
          assumption: String(x.assumption || "").slice(0,240)
        }));
        res.writeHead(200, {"Content-Type":"application/json; charset=utf-8"});
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(400, {"Content-Type":"application/json; charset=utf-8"});
        res.end(JSON.stringify({error:err.message || "حدث خطأ أثناء التحليل"}));
      }
    });
    return;
  }

  // Serve the web app and static files from public/
  let requested = req.url === "/" ? "/index.html" : decodeURIComponent(req.url.split("?")[0]);
  const full = path.resolve(ROOT, "." + requested);
  if (!full.startsWith(ROOT + path.sep) && full !== path.join(ROOT, "index.html")) {
    res.writeHead(403); return res.end("Forbidden");
  }
  fs.readFile(full, (err, content) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    const ext = path.extname(full);
    const type = ext === ".html" ? "text/html; charset=utf-8" : "application/octet-stream";
    res.writeHead(200, {"Content-Type":type});
    res.end(content);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`NutriTrack AI server running on http://localhost:${PORT}`);
});
