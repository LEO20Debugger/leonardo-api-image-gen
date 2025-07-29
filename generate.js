const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { createCanvas } = require("@napi-rs/canvas");
require("dotenv").config();

// 🔐 Load Leonardo API key from .env file
const API_KEY = process.env.LEO_API_KEY;
if (!API_KEY) {
  console.error("❌ Missing LEO_API_KEY in .env");
  process.exit(1);
}

// 📁 Constants
const REF_IMAGE_PATH = "reference.png"; // 🧼 clean image layout
const OUTPUT_DIR = "output"; // Folder to save logos
const MODEL_ID = "b24e16ff-06e3-43eb-8d33-4416c2d75876"; // Lightning XL model ID

// List of clubs and their associated colors
const clubs = [
  { name: "Man United Club", color: "red" },
  { name: "Chelsea FC", color: "royal blue" },
  { name: "Everton Club", color: "deep blue" },
  { name: "Fulham Town", color: "white and black" },
  { name: "Burnley Club", color: "claret and sky blue" },
  { name: "Liverpool FC", color: "red and white" },
  { name: "Wolves United", color: "gold and black" },
  { name: "Tottenham Club", color: "navy and white" },
  { name: "Man City FC", color: "sky blue" },
  { name: "Leeds United FC", color: "yellow and blue" },
  { name: "Newcastle Club", color: "black and white" },
  { name: "Sunderland FC", color: "red and white" },
  { name: "West Ham Club", color: "claret and blue" },
  { name: "Nottingham FC", color: "red and white" },
  { name: "Crystal Palace FC", color: "blue and red" },
  { name: "Aston Villa Club", color: "claret and sky blue" },
  { name: "Brighton Club", color: "blue and white" },
  { name: "Bournemouth Club", color: "red and black" },
  { name: "Brentford Club", color: "red and white" },
];

// Uploads your cleaned reference image to Leonardo and returns the image ID
async function uploadReferenceImage(filePath) {
  const form = new FormData();
  form.append("init_image", fs.createReadStream(filePath));
  form.append("filename", path.basename(filePath));

  const response = await axios.post(
    "https://cloud.leonardo.ai/api/rest/v1/init-image",
    form,
    {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        ...form.getHeaders(),
      },
    }
  );

  return response.data.init_image_id;
}

// 🎨 Starts a generation job for a club with its color and layout
async function startLogoGeneration(clubName, color, initImageId) {
  const prompt = `Modern esport football logo using the layout of the reference image, ${color} color theme, shield shape, central soccer ball, clean background, no text, no writing, no letters`;

  const payload = {
    modelId: MODEL_ID,
    prompt,
    init_image_id: initImageId,
    init_strength: 0.5,
    width: 512,
    height: 512,
    num_images: 1,
    presetStyle: "DYNAMIC",
    alchemy: true,
    controlnets: [
      {
        initImageId,
        initImageType: "UPLOADED",
        preprocessorId: 67,
        strengthType: "High",
      },
    ],
  };

  const response = await axios.post(
    "https://cloud.leonardo.ai/api/rest/v1/generations",
    payload,
    {
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  return response.data.sdGenerationJob.generationId;
}

// Keeps checking until Leonardo says image is ready or fails
async function pollForImage(generationId) {
  let retries = 10;
  while (retries-- > 0) {
    try {
      const response = await axios.get(
        `https://cloud.leonardo.ai/api/rest/v1/generations/${generationId}`,
        {
          headers: {
            Authorization: `Bearer ${API_KEY}`,
          },
        }
      );

      const { status, generated_images } = response.data;
      if (status === "succeeded" && generated_images?.length > 0) {
        return generated_images[0].url;
      }

      if (status === "failed") throw new Error("Generation failed");
    } catch (err) {
      if (retries === 0) throw err;
      console.warn("⚠️ Retrying poll...", err.message);
    }

    await new Promise((res) => setTimeout(res, 3000));
  }

  throw new Error("❌ Timed out waiting for image generation");
}

// Downloads the generated image from Leonardo
async function downloadImage(url, filename) {
  const response = await axios.get(url, { responseType: "arraybuffer" });
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR);

  const filepath = path.join(OUTPUT_DIR, filename);
  await fs.promises.writeFile(filepath, response.data);
  console.log(`✅ Saved raw: ${filename}`);
  return filepath;
}

// Adds the club name text onto the downloaded logo image
async function addTextToImage(inputPath, outputPath, text) {
  const width = 512;
  const height = 512;
  let fontSize = 36;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  // Shrink font size if text is too long to fit
  ctx.font = `${fontSize}px sans-serif`;
  let textWidth = ctx.measureText(text).width;
  while (textWidth > width * 0.8 && fontSize > 18) {
    fontSize -= 2;
    ctx.font = `${fontSize}px sans-serif`;
    textWidth = ctx.measureText(text).width;
  }

  // 🎨 Final text render settings
  ctx.fillStyle = "white";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(text, width / 2, height * 0.22); // ~22% from the top of image

  // 🧩 Overlay the text layer onto the original logo image
  const textBuffer = canvas.toBuffer("image/png");

  await sharp(inputPath)
    .composite([{ input: textBuffer, top: 0, left: 0 }])
    .toFile(outputPath);

  console.log(`🆗 Final saved: ${outputPath}`);
}

// MAIN: Loop through all clubs and generate final logos
(async () => {
  try {
    console.log("📤 Uploading reference image...");
    const initImageId = await uploadReferenceImage(REF_IMAGE_PATH);

    for (const [index, club] of clubs.entries()) {
      console.log(
        `🎨 (${index + 1}/${clubs.length}) Generating for: ${club.name}`
      );

      const generationId = await startLogoGeneration(
        club.name,
        club.color,
        initImageId
      );

      const imageUrl = await pollForImage(generationId);

      // 🧼 Format filenames
      const rawName = club.name.toLowerCase().replace(/[^a-z0-9]/gi, "_");
      const rawFileName = rawName + ".jpg"; // without text
      const finalFileName = rawName + "_new.jpg"; // with text

      // Download and annotate
      const rawPath = await downloadImage(imageUrl, rawFileName);
      const finalPath = path.join(OUTPUT_DIR, finalFileName);
      await addTextToImage(rawPath, finalPath, club.name);

      // Short pause to avoid hitting rate limits
      await new Promise((res) => setTimeout(res, 2000));
    }

    console.log("🏁 All done! Logos saved in /output");
  } catch (err) {
    console.error("❌ Error:", err.response?.data || err.message);
  }
})();
