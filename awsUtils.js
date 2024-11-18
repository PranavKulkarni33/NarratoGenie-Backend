const AWS = require('aws-sdk');
require('dotenv').config();
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configure AWS SDK
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_DEFAULT_REGION,
});

const s3 = new AWS.S3();
const transcribeService = new AWS.TranscribeService();

/**
 * Upload audio stream to S3
 * @param {string} bucketName - The name of the S3 bucket
 * @param {string} fileName - The name of the file to be saved in the S3 bucket
 * @param {Buffer|Stream} audioStream - The audio stream or buffer
 * @returns {Promise<Object>} - S3 upload response
 */
async function uploadToS3(bucketName, fileName, audioStream) {
  const params = {
    Bucket: bucketName,
    Key: fileName,
    Body: audioStream,
    ContentType: 'audio/mpeg',
  };

  return await s3.upload(params).promise();
}

/**
 * Start a transcription job in AWS Transcribe
 * @param {string} bucketName - The name of the S3 bucket where the audio is stored
 * @param {string} fileKey - The key of the audio file in the S3 bucket
 * @returns {Promise<Object>} - Transcription job response
 */
async function startTranscription(bucketName, fileKey) {
  const jobName = `transcription-job-${Date.now()}`;
  const params = {
    TranscriptionJobName: jobName,
    LanguageCode: 'en-US',
    Media: {
      MediaFileUri: `s3://${bucketName}/${fileKey}`,
    },
    OutputBucketName: bucketName,
  };

  console.log('Starting Transcription with Params:', params);

  try {
    const response = await transcribeService.startTranscriptionJob(params).promise();
    console.log('Transcription Start Response:', response);
    return response.TranscriptionJob;
  } catch (error) {
    console.error('Error Starting Transcription Job:', error);
    throw error;
  }
}

/**
 * Get the transcription result from S3
 * @param {string} bucketName - The name of the S3 bucket
 * @param {string} fileKey - The key of the transcription result file in the S3 bucket
 * @returns {Promise<Object>} - Transcription result
 */
async function getTranscriptionResult(bucketName, fileKey) {
  const params = {
    Bucket: bucketName,
    Key: fileKey,
  };

  const result = await s3.getObject(params).promise();
  return JSON.parse(result.Body.toString());
}

/**
 * Upload video file to S3
 * @param {string} bucketName - The name of the S3 bucket
 * @param {string} fileName - The name of the file to be saved in the S3 bucket
 * @param {string} filePath - The local path to the video file
 * @returns {Promise<Object>} - S3 upload response
 */
async function uploadVideoToS3(bucketName, fileName, filePath) {
  const fileStream = fs.createReadStream(filePath);
  const params = {
    Bucket: bucketName,
    Key: fileName,
    Body: fileStream,
    ContentType: 'video/mp4',
  };

  return await s3.upload(params).promise();
}

/**
 * Process video: Add audio and subtitles
 * @param {string} videoPath - Path to the input video
 * @param {string} audioPath - Path to the generated audio file
 * @param {string} subtitlePath - Path to the subtitle file (ASS format preferred for better styling)
 * @param {string} outputPath - Path to save the final video
 * @param {number} duration - Duration of the audio to trim the video
 * @returns {Promise<void>}
 */
async function processVideo(videoPath, audioPath, subtitlePath, outputPath, duration) {
  if (!fs.existsSync(subtitlePath)) {
    throw new Error(`Subtitle file does not exist: ${subtitlePath}`);
  }

  const ffmpegCommand = `ffmpeg -i "${path.resolve(videoPath)}" -i "${path.resolve(audioPath)}" -vf "subtitles=${path.resolve(subtitlePath)}" -t ${duration} -c:v libx264 -c:a aac -strict experimental "${path.resolve(outputPath)}"`;

  console.log('Executing FFmpeg Command:', ffmpegCommand);

  return new Promise((resolve, reject) => {
    exec(ffmpegCommand, (error, stdout, stderr) => {
      if (error) {
        console.error('Error processing video:', stderr);
        reject(new Error(`FFmpeg command failed: ${stderr}`));
      } else {
        console.log('FFmpeg Output:', stdout);
        resolve();
      }
    });
  });
}

module.exports = {
  uploadToS3,
  startTranscription,
  getTranscriptionResult,
  uploadVideoToS3,
  processVideo,
};
