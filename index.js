require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
// 1. Google Generative AI
const { GoogleGenerativeAI } = require("@google/generative-ai");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth"); // For DOCX parsing
const app = express();
const PORT = process.env.PORT;

app.use(cors({
  origin: "*"
}));
app.use(express.json());

// Since standard Express cannot handle file uploads 
// (multipart data) out of the box, we use Multer to parse the incoming resume file.
// Multer configuration to store files in memory and limit file size to 5MB.aa
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => { // parameter "_" is used to indicate that we are not using the first parameter (req) in this function
    const allowed = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ];
    allowed.includes(file.mimetype) // Check if the uploaded file's MIME type is in our allowed list (PDF or DOCX).
      ? cb(null, true) // If the file type is allowed, we call the callback with no error and a boolean true to accept the file.
      : cb(new Error("Only PDF and DOCX files are allowed"));
  },
});

// 2. Initialize Gemini Client
// Change your initialization to this:
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel(
  {
    model: "gemini-3-flash-preview",
    generationConfig: { responseMimeType: "application/json" }, // responseMimeType ensures we get a JSON response directly from the model, which simplifies parsing and reduces errors.
  },
  { apiVersion: "v1beta" }, // Ensure you're using the correct API version for Gemini 3
);

// buffer is a temporary storage area for data. When a file is uploaded, it is stored in memory as a buffer before being processed.
// This allows us to handle the file data efficiently without needing to write it to disk first.
async function extractText(file) {
  if (file.mimetype === "application/pdf") {
    const data = await pdfParse(file.buffer); // pdf-parse can directly take a buffer, 
    // so we pass file.buffer instead of converting it to a string first. This is more efficient and avoids potential encoding issues.
    return data.text;
  }
  const result = await mammoth.extractRawText({ buffer: file.buffer }); // mammoth can also take a buffer directly for DOCX files, so we pass file.buffer here as well.
  return result.value; // mammoth returns an object with a "value" property that contains the extracted text, so we return result.value to get just the text content.
}

function buildPrompt(resumeText, jobDescription) {
  return `You are an expert ATS analyst. Analyze the resume against the job description.
  
RESUME:
${resumeText}

JOB DESCRIPTION:
${jobDescription}

Return ONLY a JSON object in this shape:
{
  "ats_score": number,
  "score_breakdown": { "keyword_match": number, "experience_relevance": number, "skills_alignment": number, "formatting_ats_friendliness": number },
  "verdict": "Strong Match | Good Match | Partial Match | Weak Match",
  "summary": "string",
  "matched_keywords": ["string"],
  "missing_critical_keywords": [{ "keyword": "string", "importance": "Critical|High|Medium", "context": "string" }],
  "bullet_rewrites": [{ "original": "string", "rewritten": "string", "reason": "string" }],
  "quick_wins": ["string"],
  "red_flags": ["string"]
}`;
}

// ✅ ROOT CHECK (IMPORTANT FOR DEBUG)
app.get("/", (_, res) => {
  res.send("Backend running 🚀");
});

app.post("/api/analyze", upload.single("resume"), async (req, res) => {
  try {
    const { jobDescription } = req.body;

    if (!req.file || !jobDescription || jobDescription.trim().length < 50) {
      return res
        .status(400)
        .json({ error: "File and valid Job Description required." });
    }

    const resumeText = await extractText(req.file);

    const result = await model.generateContent( // This method is used to generate content based on the provided prompt. It sends the prompt to the Gemini model and waits for the response.
      buildPrompt(resumeText, jobDescription),
    );
    const response = await result.response;
    const rawText = response.text();

    let analysis;
    try {
      analysis = JSON.parse(rawText); // We attempt to parse the raw text response from the model as JSON. 
      // If the model's response is not valid JSON, this will throw an error, which we catch to handle parsing failures gracefully.
    } catch {
      return res.status(500).json({ error: "Failed to parse AI response." });
    }

    res.json({ success: true, analysis });
  } catch (err) {
    console.error("Analysis error:", err);
    res
      .status(500)
      .json({ error: "Something went wrong with the free AI service." });
  }
});

app.get("/api/health", (_, res) => res.json({ status: "ok" }));

app.listen(PORT, "0.0.0.0", () =>
  console.log(`✅ ATS Scorer server running on http://localhost:${PORT}`)
);