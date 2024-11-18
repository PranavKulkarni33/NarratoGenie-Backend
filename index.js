const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
require('dotenv').config();
const AWS = require('aws-sdk');
const { exec } = require('child_process');
const { uploadToS3, startTranscription, getTranscriptionResult, uploadVideoToS3 } = require('./awsUtils');

const app = express();
const PORT = 3000;

// Hugging Face API Key
const HUGGING_FACE_API_KEY = process.env.HUGGING_API;

// Middleware
app.use(bodyParser.json());
app.use(cors());

// Test Route
app.get('/', (req, res) => {
  res.send('NarratoGenie Backend with Polly and Transcribe is running!');
});

// Summarization, Speech Generation, and Subtitle Workflow
app.post('/process', async (req, res) => {
  try {
    const { content } = req.body;

    if (!content) {
      return res.status(400).json({ error: 'Content is required for summarization' });
    }

    // Step 1: Summarize Content using Hugging Face
    const summaryResponse = await axios.post(
      'https://api-inference.huggingface.co/models/facebook/bart-large-cnn',
      { inputs: content },
      {
        headers: { Authorization: `Bearer ${HUGGING_FACE_API_KEY}` },
      }
    );
    const summary = summaryResponse.data[0]?.summary_text || 'No summary generated';
    console.log('Generated Summary:', summary);

    // Step 2: Generate Speech from AWS Polly
    const pollyParams = {
      Text: summary,
      OutputFormat: 'mp3',
      VoiceId: 'Joanna',
    };

    const pollyResponse = await new Promise((resolve, reject) => {
      const polly = new AWS.Polly();
      polly.synthesizeSpeech(pollyParams, (err, data) => {
        if (err) reject(err);
        else resolve(data.AudioStream);
      });
    });

    // Save audio locally
    const audioLocalPath = `./audio-${Date.now()}.mp3`;
    fs.writeFileSync(audioLocalPath, pollyResponse);
    console.log(`Audio saved locally at: ${audioLocalPath}`);

    // Step 3: Upload Polly Audio to S3
    const audioFileName = path.basename(audioLocalPath);
    const s3AudioResponse = await uploadToS3('narratogenie-audio', audioFileName, fs.createReadStream(audioLocalPath));
    console.log('Audio uploaded to S3:', s3AudioResponse.Location);

    // Step 4: Start Transcription Job
    const transcriptionResponse = await startTranscription('narratogenie-audio', audioFileName);
    const transcriptionJobName = transcriptionResponse.TranscriptionJobName;

    console.log('Transcription Job Name:', transcriptionJobName);

    // Wait for transcription to complete
    const transcriptionResult = await waitForTranscriptionCompletion(transcriptionJobName, 'narratogenie-audio');

    // Step 5: Generate Subtitles
    const assFilePath = `./subtitles-${Date.now()}.ass`;
    generateASS(transcriptionResult, assFilePath);

    // Step 6: Process Video
    const videoPath = './videos/movie1.mp4';
    const outputVideoPath = `./output-video-${Date.now()}.mp4`;
    const audioDuration = transcriptionResult.results.audio_segments[0]?.end_time || 30; // Fallback to 30s
    await processVideo(videoPath, audioLocalPath, assFilePath, outputVideoPath, audioDuration);

    console.log('Video processing complete:', outputVideoPath);

    // Step 7: Upload Video to S3
    const videoFileName = path.basename(outputVideoPath);
    const s3VideoResponse = await uploadVideoToS3('narratogenie-video', videoFileName, outputVideoPath);
    console.log('Video uploaded to S3:', s3VideoResponse.Location);

    // Cleanup temporary files
    fs.unlinkSync(audioLocalPath);
    

    res.json({
      message: 'Process completed successfully',
      audioUrl: s3AudioResponse.Location,
      videoUrl: s3VideoResponse.Location,
    });
  } catch (error) {
    console.error('Error processing request:', error.message);
    res.status(500).json({ error: 'Failed to process the request' });
  }
});

// Start the Server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

// Function to Generate ASS with Centered, Smaller Text, and Word Transitions
function generateASS(transcriptionResult, filePath) {
  const items = transcriptionResult.results.items;

  const assHeader = `
[Script Info]
Title: Subtitles
ScriptType: v4.00+
Collisions: Normal
PlayDepth: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default, Arial, 24, &H00FFFFFF, &H000000FF, &H00000000, &H64000000, -1, 0, 1, 1, 0, 2, 20, 20, 50, 1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    const assBody = items
    .map((item) => {
    if (item.start_time && item.end_time && item.alternatives[0]?.content) {
        const startTime = formatTime(item.start_time);
        const endTime = formatTime(item.end_time);
        const text = item.alternatives[0]?.content || '';

        return `Dialogue: 0,${startTime},${endTime},Default,,0,0,0,,${text}`;
    }
    return '';
    })
    .join('\n');

  const assContent = assHeader + assBody;
  fs.writeFileSync(filePath, assContent, 'utf8');
  console.log('ASS file generated:', filePath);
}

// Helper Function to Format Time
function formatTime(seconds) {
  const date = new Date(0);
  date.setSeconds(parseFloat(seconds));
  return date.toISOString().substr(11, 12).replace('.', ',');
}

async function waitForTranscriptionCompletion(jobName, bucketName) {
  const checkInterval = 5000;
  const maxRetries = 6;

  for (let i = 0; i < maxRetries; i++) {
    const transcriptionResult = await getTranscriptionResult(bucketName, `${jobName}.json`).catch(() => null);
    if (transcriptionResult) {
      return transcriptionResult;
    }
    console.log(`Waiting for transcription to complete... (${i + 1}/${maxRetries})`);
    await new Promise((resolve) => setTimeout(resolve, checkInterval));
  }

  throw new Error('Transcription did not complete within the expected time.');
}

async function processVideo(videoPath, audioPath, subtitlePath, outputPath, duration) {
  if (!fs.existsSync(subtitlePath)) {
    throw new Error(`Subtitle file does not exist: ${subtitlePath}`);
  }

  const ffmpegCommand = `ffmpeg -i "${path.resolve(videoPath)}" -i "${path.resolve(audioPath)}" -vf "subtitles=${path.resolve(subtitlePath)}" -t ${duration} -c:v libx264 -c:a aac -strict experimental "${path.resolve(outputPath)}"`;

  console.log('Executing FFmpeg Command:', ffmpegCommand);

  return new Promise((resolve, reject) => {
    exec(ffmpegCommand, (error, stdout, stderr) => {
      if (error) {
        console.error('Error processing video:', error.message);
        reject(new Error(`FFmpeg command failed: ${stderr}`));
      } else {
        console.log('FFmpeg Output:', stdout);
        resolve();
      }
    });
  });
}
