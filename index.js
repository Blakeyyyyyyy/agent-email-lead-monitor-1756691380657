const express = require('express');
const { google } = require('googleapis');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

// Initialize APIs
const oauth2Client = new google.auth.OAuth2();
oauth2Client.setCredentials({
  access_token: process.env.GMAIL_ACCESS_TOKEN,
  refresh_token: process.env.GMAIL_REFRESH_TOKEN
});

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// In-memory storage for processing state
let processedEmails = new Set();
let logs = [];

function log(message) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}`;
  console.log(logEntry);
  logs.push(logEntry);
  if (logs.length > 100) logs.shift(); // Keep last 100 logs
}

// Analyze email content to determine if it's a service inquiry
async function analyzeEmailContent(subject, body) {
  try {
    const prompt = `Analyze this email to determine if the sender is inquiring about business services, products, or is a potential lead.

Subject: ${subject}
Body: ${body}

Respond with a JSON object containing:
- "isLead": boolean (true if this appears to be a service inquiry or potential business lead)
- "confidence": number (0-1, how confident you are)
- "reason": string (brief explanation of why this is/isn't a lead)
- "keywords": array of relevant keywords found

Consider these as potential lead indicators:
- Asking about services, products, pricing
- Requesting quotes or information
- Business inquiries
- Partnership opportunities
- Questions about capabilities

Exclude:
- Personal emails
- Spam/promotional emails
- Newsletters
- Social notifications
- Internal communications`;

    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3
    });

    return JSON.parse(response.choices[0].message.content);
  } catch (error) {
    log(`Error analyzing email content: ${error.message}`);
    return { isLead: false, confidence: 0, reason: "Analysis failed", keywords: [] };
  }
}

// Generate draft response based on email content and lead status
async function generateDraftResponse(originalEmail, isLead, analysis) {
  try {
    const prompt = isLead ? 
      `Generate a professional, friendly draft response to this potential business lead inquiry:

Original Email Subject: ${originalEmail.subject}
Original Email: ${originalEmail.body}
Sender: ${originalEmail.from}

Create a response that:
- Thanks them for their interest
- Acknowledges their specific inquiry
- Provides helpful information about your services
- Includes a call to action (meeting, call, more info)
- Maintains a professional but warm tone
- Is concise but informative

Do not include placeholder company information - keep it generic but professional.` :
      
      `Generate a brief, polite response to this email:

Original Email Subject: ${originalEmail.subject}
Original Email: ${originalEmail.body}
Sender: ${originalEmail.from}

Create a short, courteous response that:
- Acknowledges their message
- Is helpful and professional
- Keeps it brief since this isn't a business inquiry`;

    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 300
    });

    return response.choices[0].message.content;
  } catch (error) {
    log(`Error generating draft response: ${error.message}`);
    return isLead ? 
      "Thank you for your inquiry about our services. I'll get back to you shortly with more information." :
      "Thank you for your email. I'll review it and get back to you if needed.";
  }
}

// Create draft response in Gmail
async function createDraftResponse(originalMessageId, to, subject, body, threadId) {
  try {
    const draftResponse = {
      message: {
        threadId: threadId,
        raw: Buffer.from([
          `To: ${to}`,
          `Subject: Re: ${subject}`,
          `In-Reply-To: ${originalMessageId}`,
          `References: ${originalMessageId}`,
          '',
          body
        ].join('\r\n')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_')
      }
    };

    const draft = await gmail.users.drafts.create({
      userId: 'me',
      requestBody: draftResponse
    });

    return draft.data;
  } catch (error) {
    log(`Error creating draft response: ${error.message}`);
    throw error;
  }
}

// Add label to email
async function addLabelToEmail(messageId, labelName) {
  try {
    // First, check if label exists, create if not
    let labelId;
    try {
      const labels = await gmail.users.labels.list({ userId: 'me' });
      const existingLabel = labels.data.labels.find(label => label.name === labelName);
      
      if (existingLabel) {
        labelId = existingLabel.id;
      } else {
        const newLabel = await gmail.users.labels.create({
          userId: 'me',
          requestBody: {
            name: labelName,
            labelListVisibility: 'labelShow',
            messageListVisibility: 'show'
          }
        });
        labelId = newLabel.data.id;
      }
    } catch (error) {
      log(`Error managing label: ${error.message}`);
      return;
    }

    // Add label to message
    await gmail.users.messages.modify({
      userId: 'me',
      id: messageId,
      requestBody: {
        addLabelIds: [labelId]
      }
    });

    log(`Added label "${labelName}" to message ${messageId}`);
  } catch (error) {
    log(`Error adding label to email: ${error.message}`);
  }
}

// Process a single email
async function processEmail(message) {
  try {
    const fullMessage = await gmail.users.messages.get({
      userId: 'me',
      id: message.id,
      format: 'full'
    });

    const headers = fullMessage.data.payload.headers;
    const subject = headers.find(h => h.name === 'Subject')?.value || '';
    const from = headers.find(h => h.name === 'From')?.value || '';
    const to = headers.find(h => h.name === 'To')?.value || '';

    // Extract email body
    let body = '';
    if (fullMessage.data.payload.body.data) {
      body = Buffer.from(fullMessage.data.payload.body.data, 'base64').toString();
    } else if (fullMessage.data.payload.parts) {
      const textPart = fullMessage.data.payload.parts.find(part => part.mimeType === 'text/plain');
      if (textPart?.body.data) {
        body = Buffer.from(textPart.body.data, 'base64').toString();
      }
    }

    log(`Processing email from ${from}: ${subject}`);

    // Analyze email content
    const analysis = await analyzeEmailContent(subject, body);
    const isLead = analysis.isLead && analysis.confidence > 0.6;

    log(`Email analysis - Lead: ${isLead}, Confidence: ${analysis.confidence}, Reason: ${analysis.reason}`);

    // Generate draft response
    const draftBody = await generateDraftResponse(
      { subject, body, from, to },
      isLead,
      analysis
    );

    // Create draft response
    await createDraftResponse(
      message.id,
      from,
      subject,
      draftBody,
      fullMessage.data.threadId
    );

    // Add appropriate label
    const labelName = isLead ? 'lead' : 'other';
    await addLabelToEmail(message.id, labelName);

    log(`Successfully processed email ${message.id} - Created draft and added "${labelName}" label`);
    
    return {
      success: true,
      messageId: message.id,
      from,
      subject,
      isLead,
      confidence: analysis.confidence,
      label: labelName
    };

  } catch (error) {
    log(`Error processing email ${message.id}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Monitor emails for new messages
async function monitorEmails() {
  try {
    log('Checking for new emails...');

    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread',
      maxResults: 10
    });

    if (!response.data.messages) {
      log('No new emails found');
      return { processed: 0, results: [] };
    }

    const newEmails = response.data.messages.filter(msg => !processedEmails.has(msg.id));
    
    if (newEmails.length === 0) {
      log('No new unprocessed emails found');
      return { processed: 0, results: [] };
    }

    log(`Found ${newEmails.length} new emails to process`);

    const results = [];
    for (const email of newEmails) {
      const result = await processEmail(email);
      results.push(result);
      processedEmails.add(email.id);
      
      // Small delay between processing emails
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return { processed: newEmails.length, results };

  } catch (error) {
    log(`Error monitoring emails: ${error.message}`);
    throw error;
  }
}

// API Endpoints
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    service: 'Email Lead Monitor',
    description: 'Monitors emails 24/7, identifies leads, creates draft responses, and adds labels',
    endpoints: {
      'GET /': 'Service status and endpoints',
      'GET /health': 'Health check',
      'GET /logs': 'View recent logs',
      'POST /test': 'Test email monitoring manually',
      'POST /monitor': 'Run email monitoring cycle'
    },
    stats: {
      processedEmails: processedEmails.size,
      totalLogs: logs.length
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    processedEmails: processedEmails.size
  });
});

app.get('/logs', (req, res) => {
  res.json({ 
    logs: logs.slice(-50), // Return last 50 logs
    total: logs.length 
  });
});

app.post('/test', async (req, res) => {
  try {
    log('Manual test triggered');
    const result = await monitorEmails();
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      ...result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/monitor', async (req, res) => {
  try {
    const result = await monitorEmails();
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      ...result
    });
  } catch (error) {
    log(`Monitor endpoint error: ${error.message}`);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Continuous monitoring (every 2 minutes)
setInterval(async () => {
  try {
    await monitorEmails();
  } catch (error) {
    log(`Scheduled monitoring error: ${error.message}`);
  }
}, 2 * 60 * 1000); // 2 minutes

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`Email Lead Monitor agent started on port ${PORT}`);
  log('Monitoring emails every 2 minutes...');
});

module.exports = app;