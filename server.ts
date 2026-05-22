import express from "express";
import path from "path";
import multer from "multer";
import { GoogleGenAI, Type } from "@google/genai";
import { createServer as createViteServer } from "vite";

const upload = multer({ storage: multer.memoryStorage() });

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // AI Pipeline for CSV mapping
  app.post("/api/upload-csv", upload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const csvContent = req.file.buffer.toString("utf8");
      
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: "GEMINI_API_KEY is missing." });
      }

      const ai = new GoogleGenAI({ apiKey });

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
          {
            role: "user",
            parts: [
              {
                text: `You are an AI assistant that maps CSV data into a specific JSON schema.
Here is a raw CSV content of daily tank inspections:

${csvContent}

Please parse this data and extract it into a JSON array. Our target JSON format represents these columns:
- no: No Lexam
- tglCleaning: Tanggal Cleaning (YYYY-MM-DD or empty)
- perlakuan: Perlakuan Terakhir pada lexam
- sanitasi: Sanitasi ke-
- estClean: Estimasi Cleaning / Pengulangan (YYYY-MM-DD or empty)
- tglKirim: Tanggal Kirim Ke Tempat Tujuan (YYYY-MM-DD or empty)
- statusInfo: Status Info
- peruntukkan: Peruntukkan Lexam
- posisi: Posisi
- keterangan: Keterangan Tambahan
- hariIni: Hari Ini (YYYY-MM-DD or empty)
- statusSaatIni: Status Saat Ini

Output only the matched raw rows based on the CSV data provided as a JSON array of objects fitting this schema.`
              }
            ]
          }
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                no: { type: Type.STRING },
                tglCleaning: { type: Type.STRING, description: "Format YYYY-MM-DD" },
                perlakuan: { type: Type.STRING },
                sanitasi: { type: Type.STRING },
                estClean: { type: Type.STRING, description: "Format YYYY-MM-DD" },
                tglKirim: { type: Type.STRING, description: "Format YYYY-MM-DD" },
                statusInfo: { type: Type.STRING },
                peruntukkan: { type: Type.STRING },
                posisi: { type: Type.STRING },
                keterangan: { type: Type.STRING },
                hariIni: { type: Type.STRING, description: "Format YYYY-MM-DD" },
                statusSaatIni: { type: Type.STRING }
              }
            }
          }
        }
      });

      const jsonText = response.text;
      if (!jsonText) {
         throw new Error("Empty response from AI.");
      }

      let parsedData = [];
      try {
         parsedData = JSON.parse(jsonText);
      } catch(e) {
         return res.status(500).json({ error: "Failed to parse AI response" });
      }

      res.json({ data: parsedData });
    } catch (err: any) {
      console.error(err);
      res.status(500).json({ error: err.message || "Failed to process CSV via AI" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
