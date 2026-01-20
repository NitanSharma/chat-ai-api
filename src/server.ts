import  express, {type Request , type Response} from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();
import { StreamChat } from 'stream-chat';
import OpenAI from 'openai';
import { db } from './config/database.js';
import { users ,chats } from './db/schema.js';
import { eq } from 'drizzle-orm';
import type { ChatCompletionMessageParam } from 'openai/resources';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.get('/', (req, res) => {
    res.send('Server is running!');
});

//Initialize Stream Chat client
const apiKey = process.env.STREAM_API_KEY || '';
const apiSecret = process.env.STREAM_API_SECRET || '';
const chatClient = StreamChat.getInstance(apiKey, apiSecret);

//Initialize OpenAI client
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || '',
});

// Register user with Stream Chat
app.post(
  '/register-user',
  async (req: Request, res: Response): Promise<any> => {
    const { name, email } = req.body;
    console.log(req.body)

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required' });
    }

    try {
      const userId = email.replace(/[^a-zA-Z0-9_-]/g, '_');

      // Check if user exists
      const userResponse = await chatClient.queryUsers({ id: { $eq: userId } });

      if (!userResponse.users.length) {
        // Add new user to stream
        await chatClient.upsertUser({
          id: userId,
          name: name,
          email :  email,
          role: 'user',
        } as any);
      }

     // Check for existing user in database
      const existingUser = await db
        .select()
        .from(users)
        .where(eq(users.userId, userId));

      if (!existingUser.length) {
        console.log(
          `User ${userId} does not exist in the database. Adding them...`
        );
        await db.insert(users).values({ userId, name, email });
      }

      res.status(200).json({ userId, name, email });
    } catch (error) {
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
);

// Endpoint to handle chat messages
app.post("/chat", async (req: Request, res: Response) => {
  const { userId, message } = req.body;

  if (!message || !userId) {
    return res.status(400).json({ error: "User ID and message are required" });
  }

  try {
    // verify user exists in Stream
    const userResponse = await chatClient.queryUsers({ id: userId });
    if (!userResponse.users.length) {
      return res.status(404).json({ error: "User not found" });
    }

    // Check user in database
    const existingUser = await db
      .select()
      .from(users)
      .where(eq(users.userId, userId));

      if (!existingUser.length) {
      return res
        .status(404)
        .json({ error: 'User not found in database, please register' });
    }


     // Fetch users past messages for context
    const chatHistory = await db
      .select()
      .from(chats)
      .where(eq(chats.userId, userId))
      .orderBy(chats.createdAt)
      .limit(10);

    // Format chat history for Open AI
    const conversation: ChatCompletionMessageParam[] = chatHistory.flatMap(
      (chat) => [
        { role: 'user', content: chat.message },
        { role: 'assistant', content: chat.reply },
      ]
    );

    // Add latest user messages to the conversation
    conversation.push({ role: 'user', content: message });

    const response = await openai.responses.create({
       model: "gpt-4o-mini",
       input: message,
       store: true,
   });
    // console.log("OpenAI response:", response.output_text);
   const aiMessage : string = response.output_text ?? "No response from AI";

    // Save chat to database
    await db.insert(chats).values({ userId, message, reply: aiMessage });



   // Create or get channel
    const channel = chatClient.channel('messaging', `chat-${userId}`, {
      name: 'AI Chat',
      created_by_id: 'ai_bot',
    } as any);

    await channel.create();
    await channel.sendMessage({ text: aiMessage, user_id: 'ai_bot' });

    res.status(200).json({ reply: aiMessage });


    return res.status(200).json({ response: aiMessage });
  } catch (error) {
    console.error("Chat error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// health route
app.get("/health", (req : Request, res : Response) => {
  res.status(200).json({ status: "OK", message: "Server is awake." });
});

// Get chat history for a user
app.post('/get-messages', async (req: Request, res: Response): Promise<any> => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'User ID is required' });
  }

  try {
    const chatHistory = await db
      .select()
      .from(chats)
      .where(eq(chats.userId, userId));

    res.status(200).json({ messages: chatHistory });
  } catch (error) {
    console.log('Error fetching chat history', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});