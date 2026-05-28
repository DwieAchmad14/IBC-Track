import express from "express";
import path from "path";
import fs from "fs";
import multer from "multer";
import { GoogleGenAI, Type } from "@google/genai";
import { createServer as createViteServer } from "vite";

const upload = multer({ storage: multer.memoryStorage() });

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  app.get("/firebase-applet-config.json", (req, res) => {
    const configPath = path.join(process.cwd(), "firebase-applet-config.json");
    if (fs.existsSync(configPath)) {
      res.sendFile(configPath);
    } else {
      res.status(404).json({ error: "Firebase config not found" });
    }
  });

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

  // Google Sheets LOAD proxy route
  app.get("/api/sheets/load", async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      const spreadsheetId = req.query.spreadsheetId || "1cSuochPC5Rwb68t59eJ-0VrLdUi65e8F_G8Quny53Ng";
      let rows: any[] = [];
      let source = "none";

      if (authHeader) {
        console.log("Fetching authenticated Sheets API via server-side proxy...");
        const apiRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/A2:O`, {
          headers: { "Authorization": authHeader }
        });

        if (apiRes.ok) {
          const result = await apiRes.json();
          rows = result.values || [];
          source = "authenticated_api";
        } else {
          const errText = await apiRes.text();
          console.warn("Authenticated API fetch failed. Status:", apiRes.status, "Error:", errText);
        }
      }

      // If auth fetch failed/empty or wasn't provided, fetch public CSV fallback
      if (rows.length === 0) {
        console.log("Fetching public CSV export URL via server-side proxy...");
        const csvRes = await fetch(`https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv`);
        if (csvRes.ok) {
          const csvText = await csvRes.text();
          return res.json({ success: true, source: "public_csv_raw", rawCsv: csvText });
        } else {
          console.error("Public CSV export failed. Status:", csvRes.status);
          return res.status(500).json({ error: "Gagal memuat Google Sheet secara privat maupun publik." });
        }
      }

      return res.json({ success: true, source, values: rows });
    } catch (error: any) {
      console.error("Server proxy load error:", error);
      return res.status(500).json({ error: error.message || "Failed to load sheets via proxy" });
    }
  });

  // Google Sheets SAVE proxy route
  app.post("/api/sheets/save", async (req, res) => {
    try {
      const { values, spreadsheetId } = req.body;
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).json({ error: "Unauthorized: Missing access token" });
      }

      const sid = spreadsheetId || "1cSuochPC5Rwb68t59eJ-0VrLdUi65e8F_G8Quny53Ng";

      // 1. Clear cells A2:Z
      console.log("Clearing sheets A2:Z via server-side proxy...");
      const clearRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/A2:Z:clear`, {
        method: "POST",
        headers: {
          "Authorization": authHeader,
          "Content-Type": "application/json"
        }
      });

      if (!clearRes.ok) {
        const clearErr = await clearRes.text();
        console.error("Clear error:", clearErr);
        return res.status(clearRes.status).json({ error: `Gagal mengosongkan sheet: ${clearErr}` });
      }

      // 2. Append new values
      console.log("Appending values to A2:K via server-side proxy...");
      const params = new URLSearchParams({ valueInputOption: "USER_ENTERED", insertDataOption: "OVERWRITE" });
      const appendRes = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${sid}/values/A2:K:append?${params.toString()}`, {
        method: "POST",
        headers: {
          "Authorization": authHeader,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ values })
      });

      if (!appendRes.ok) {
        const appendErr = await appendRes.text();
        console.error("Append error:", appendErr);
        return res.status(appendRes.status).json({ error: `Gagal menyisipkan data: ${appendErr}` });
      }

      const appendData = await appendRes.json();
      return res.json({ success: true, data: appendData });
    } catch (error: any) {
      console.error("Server proxy save error:", error);
      return res.status(500).json({ error: error.message || "Failed to save data to sheets via proxy" });
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
