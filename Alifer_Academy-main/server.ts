import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { INITIAL_CATEGORIES } from './src/data/categoriesData';
import { COURSES_DATA, INITIAL_THUMBNAILS, INITIAL_ANNOUNCEMENTS, INITIAL_TRANSACTIONS, INITIAL_NOTIFICATIONS } from './src/data/mockData';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Firebase Admin initialization
let firebaseMessaging: ReturnType<typeof getMessaging> | null = null;

try {
  const firebaseApp = getApps()[0] || (() => {
    const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

    if (rawServiceAccount) {
      const serviceAccount = JSON.parse(rawServiceAccount);
      return initializeApp({ credential: cert(serviceAccount) });
    }

    return initializeApp({ credential: applicationDefault() });
  })();

  firebaseMessaging = getMessaging(firebaseApp);
} catch (firebaseInitError) {
  console.warn('[Firebase Admin] Push notifications disabled: credentials are not configured.');
}

async function sendPushNotification(
  title: string,
  message: string,
  imageUrl?: string
) {
  if (!firebaseMessaging) {
    return {
      successCount: 0,
      failureCount: 0,
      message: 'Firebase push credentials are not configured.',
    };
  }

  const tokens = [...new Set(dataStore.fcmTokens)];

  if (tokens.length === 0) {
    return {
      successCount: 0,
      failureCount: 0,
      message: 'No registered devices found.',
    };
  }

  let successCount = 0;
  let failureCount = 0;
  const invalidTokens: string[] = [];

  for (let i = 0; i < tokens.length; i += 500) {
    const batch = tokens.slice(i, i + 500);

    const response = await firebaseMessaging.sendEachForMulticast({
      tokens: batch,
      notification: {
        title,
        body: message,
        ...(imageUrl ? { imageUrl } : {}),
      },
      webpush: {
        notification: {
          title,
          body: message,
          ...(imageUrl ? { image: imageUrl } : {}),
        },
      },
    });

    successCount += response.successCount;
    failureCount += response.failureCount;

    response.responses.forEach((result, index) => {
      if (
        !result.success &&
        [
          'messaging/invalid-registration-token',
          'messaging/registration-token-not-registered',
        ].includes(result.error?.code || '')
      ) {
        invalidTokens.push(batch[index]);
      }
    });
  }

  if (invalidTokens.length > 0) {
    dataStore.fcmTokens = dataStore.fcmTokens.filter(
      token => !invalidTokens.includes(token)
    );
    saveDataStore();
  }

  return {
    successCount,
    failureCount,
    message: '',
  };
}

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json({ limit: '15mb' }));

// Google Gemini AI
const apiKey = process.env.GEMINI_API_KEY || '';
let aiClient: GoogleGenAI | null = null;

if (apiKey) {
  aiClient = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const ALIFER_AI_SYSTEM_INSTRUCTION = `You are the official ALIFER AI ASSISTANT, the dedicated academic mentor and doubt-clearing tutor for Alifer Academy students.
Founded with the philosophy "Learning For All", Alifer Academy delivers world-class education in:
- Mathematics (Algebra, Calculus, Geometry, Trigonometry, Statistics)
- Science (Physics, Chemistry, Biology)
- Computer Science & Programming (Python, C++, Java, Web Development, Data Structures & Algorithms)
- Electronics & Engineering Fundamentals
- Exam Preparation (Boards, Competitive, Engineering & Skills)

Your Persona & Capabilities:
1. Provide accurate, clear, and structured step-by-step explanations.
2. Be warm, motivating, encouraging, and academically rigorous.
3. Support both English, Hindi, and natural Hinglish seamlessly based on what the student prefers.
4. When explaining mathematical or scientific formulas, write clean mathematical notations.
5. If analyzing an attached image of a question, homework problem, or circuit diagram, break down the visible text/figure first, then provide the solution and underlying concepts.
6. When answering coding questions, explain logic first, provide clean, commented code, and highlight edge cases.
7. Offer follow-up practice suggestions to test understanding.`;

// AI Chat API
app.post('/api/ai/chat', async (req, res) => {
  try {
    const {
      message,
      history = [],
      image = null,
      subject = 'General',
    } = req.body;

    if (!message && !image) {
      return res.status(400).json({
        error: 'Message or image attachment is required.',
      });
    }

    if (!apiKey || !aiClient) {
      return res.status(200).json({
        reply: `Hello! I am the Alifer AI Assistant. The Gemini API key has not been configured in the environment settings yet.

Once configured in Settings > Secrets, I can assist you with:
- Step-by-step math and physics problem solving
- Coding and debug assistance (C++, Python, Java, Web)
- Doubt solving from textbook photo uploads
- Concept summaries in English and Hindi / Hinglish.

Your prompt was: "${message || 'Image uploaded'}" (Subject: ${subject})`,
        isOfflineMode: true,
      });
    }

    const parts: any[] = [];

    if (image && typeof image === 'string' && image.includes(',')) {
      const match = image.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9-.+]+);base64,(.+)$/);

      if (match) {
        parts.push({
          inlineData: {
            mimeType: match[1],
            data: match[2],
          },
        });
      }
    }

    let promptText = '';

    if (history && Array.isArray(history) && history.length > 0) {
      const recent = history.slice(-4);

      promptText += `Previous context:\n`;

      for (const h of recent) {
        promptText += `${h.role === 'user' ? 'Student' : 'Alifer Assistant'}: ${h.text}\n`;
      }

      promptText += `\nCurrent Subject focus: ${subject}\n`;
      promptText += `Student's New Question: ${message || 'Please solve and explain the attached image question.'}`;
    } else {
      promptText = `Subject focus: ${subject}\nStudent's Question: ${message || 'Please solve and explain the attached image question.'}`;
    }

    parts.push({ text: promptText });

    const response = await aiClient.models.generateContent({
      model: 'gemini-3.8-flash',
      contents: { parts },
      config: {
        systemInstruction: ALIFER_AI_SYSTEM_INSTRUCTION,
      },
    });

    const reply = response.text || 'I could not generate a response. Please try rephrasing your question.';

    return res.json({
      reply,
      isOfflineMode: false,
    });
  } catch (error: any) {
    console.error('Error generating AI response:', error);

    return res.status(500).json({
      error: error.message || 'Failed to process AI query',
      reply: `Sorry, an error occurred while connecting to Alifer AI Assistant: ${error.message || 'Internal error'}. Please try again shortly.`,
    });
  }
});

// Health check
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    academy: 'Alifer Academy',
    version: '1.0.0',
    geminiConfigured: !!apiKey,
    razorpayConfigured: !!(
      process.env.RAZORPAY_KEY_ID &&
      process.env.RAZORPAY_KEY_SECRET
    ),
  });
});

// ==========================================
// PERSISTENT STORAGE ENGINE
// ==========================================

const STORAGE_DIR = path.resolve(__dirname, 'storage');
const DATA_FILE = path.join(STORAGE_DIR, 'academy-data.json');

interface AcademyDataStore {
  categories: any[];
  courses: any[];
  thumbnails: any[];
  announcements: any[];
  notifications: any[];
  queries: any[];
  transactions: any[];
  studentCourseAccess: Record<string, string[]>;
  fcmTokens: string[];
}

let dataStore: AcademyDataStore = {
  categories: [],
  courses: [],
  thumbnails: [],
  announcements: [],
  notifications: [],
  queries: [],
  transactions: [],
  studentCourseAccess: {},
  fcmTokens: [],
};

function initDataStore() {
  try {
    if (!fs.existsSync(STORAGE_DIR)) {
      fs.mkdirSync(STORAGE_DIR, { recursive: true });
    }

    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      const parsed = JSON.parse(raw);

      dataStore = {
        categories:
          Array.isArray(parsed.categories) && parsed.categories.length > 0
            ? parsed.categories
            : INITIAL_CATEGORIES,

        courses:
          Array.isArray(parsed.courses) && parsed.courses.length > 0
            ? parsed.courses
            : COURSES_DATA,

        thumbnails:
          Array.isArray(parsed.thumbnails) && parsed.thumbnails.length > 0
            ? parsed.thumbnails
            : INITIAL_THUMBNAILS,

        announcements:
          Array.isArray(parsed.announcements) && parsed.announcements.length > 0
            ? parsed.announcements
            : INITIAL_ANNOUNCEMENTS,

        notifications:
          Array.isArray(parsed.notifications) && parsed.notifications.length > 0
            ? parsed.notifications
            : INITIAL_NOTIFICATIONS,

        queries: Array.isArray(parsed.queries) ? parsed.queries : [],

        fcmTokens: Array.isArray(parsed.fcmTokens)
          ? parsed.fcmTokens
          : [],

        transactions:
          Array.isArray(parsed.transactions) && parsed.transactions.length > 0
            ? parsed.transactions
            : INITIAL_TRANSACTIONS,

        studentCourseAccess:
          parsed.studentCourseAccess &&
          typeof parsed.studentCourseAccess === 'object'
            ? parsed.studentCourseAccess
            : {
                'STU-ALF-2026-8841': ['course-calc-mastery'],
              },
      };
    } else {
      dataStore = {
        categories: INITIAL_CATEGORIES,
        courses: COURSES_DATA,
        thumbnails: INITIAL_THUMBNAILS,
        announcements: INITIAL_ANNOUNCEMENTS,
        notifications: INITIAL_NOTIFICATIONS,
        queries: [],
        transactions: INITIAL_TRANSACTIONS,

        studentCourseAccess: {
          'STU-ALF-2026-8841': ['course-calc-mastery'],
        },

        fcmTokens: [],
      };

      fs.writeFileSync(
        DATA_FILE,
        JSON.stringify(dataStore, null, 2),
        'utf-8'
      );
    }
  } catch (err) {
    console.error(
      '[Storage] Error initializing academy data store, falling back to memory seed:',
      err
    );

    dataStore = {
      categories: INITIAL_CATEGORIES,
      courses: COURSES_DATA,
      thumbnails: INITIAL_THUMBNAILS,
      announcements: INITIAL_ANNOUNCEMENTS,
      notifications: INITIAL_NOTIFICATIONS,
      queries: [],
      transactions: INITIAL_TRANSACTIONS,

      studentCourseAccess: {
        'STU-ALF-2026-8841': ['course-calc-mastery'],
      },

      fcmTokens: [],
    };
  }
}

function saveDataStore() {
  try {
    if (!fs.existsSync(STORAGE_DIR)) {
      fs.mkdirSync(STORAGE_DIR, { recursive: true });
    }

    fs.writeFileSync(
      DATA_FILE,
      JSON.stringify(dataStore, null, 2),
      'utf-8'
    );
  } catch (err) {
    console.error('[Storage] Failed to save academy data store:', err);
  }
}

initDataStore();

// ==========================================
// 1. ADMIN AUTHENTICATION
// ==========================================

const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || '';
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const adminSessions = new Map<string, number>();
const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const ADMIN_COOKIE = 'alifer_admin_session';

function readCookie(
  req: express.Request,
  name: string
): string | undefined {
  const cookieHeader = req.headers.cookie || '';

  for (const part of cookieHeader.split(';')) {
    const separatorIndex = part.indexOf('=');

    if (separatorIndex === -1) continue;

    const key = part.slice(0, separatorIndex).trim();

    if (key !== name) continue;

    const rawValue = part.slice(separatorIndex + 1).trim();

    try {
      return decodeURIComponent(rawValue);
    } catch {
      return undefined;
    }
  }

  return undefined;
}

function getAdminSessionTokens(req: express.Request): string[] {
  const tokens: string[] = [];

  const cookieToken = readCookie(req, ADMIN_COOKIE);
  const authHeader = req.headers.authorization || '';

  const bearerToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : undefined;

  if (cookieToken) tokens.push(cookieToken);

  if (bearerToken && !tokens.includes(bearerToken)) {
    tokens.push(bearerToken);
  }

  return tokens;
}

function getAdminSession(req: express.Request): string | undefined {
  const now = Date.now();

  for (const token of getAdminSessionTokens(req)) {
    const expiresAt = adminSessions.get(token);

    if (expiresAt && expiresAt > now) {
      return token;
    }

    if (expiresAt !== undefined) {
      adminSessions.delete(token);
    }
  }

  return undefined;
}

function requireAdmin(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  if (getAdminSession(req)) {
    return next();
  }

  return res.status(401).json({
    success: false,
    error: 'Unauthorized. Please log in as admin.',
  });
}

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const attempt = loginAttempts.get(ip);

  if (attempt && attempt.resetAt > now && attempt.count >= 10) {
    return res.status(429).json({
      success: false,
      error: 'Too many login attempts. Please try again later.',
    });
  }

  if (!ADMIN_PASSCODE.trim()) {
    return res.status(503).json({
      success: false,
      error: 'Admin login is not configured. Set ADMIN_PASSCODE in server environment secrets.',
    });
  }

  const supplied =
    typeof req.body?.passcode === 'string'
      ? req.body.passcode.trim()
      : '';

  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(ADMIN_PASSCODE);

  const valid =
    suppliedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);

  if (!valid) {
    const current =
      attempt && attempt.resetAt > now
        ? attempt
        : {
            count: 0,
            resetAt: now + 15 * 60 * 1000,
          };

    current.count += 1;
    loginAttempts.set(ip, current);

    return res.status(401).json({
      success: false,
      error: 'Invalid Director Security Passcode.',
    });
  }

  loginAttempts.delete(ip);

  const token = crypto.randomBytes(32).toString('hex');

  adminSessions.set(token, now + ADMIN_SESSION_TTL_MS);

  const secureFlag =
    process.env.NODE_ENV === 'production' ? '; Secure' : '';

  res.setHeader(
    'Set-Cookie',
    `${ADMIN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}${secureFlag}`
  );

  return res.json({
    success: true,
    token,
    director: 'Er. Alifer Sir',
    role: 'director',
    message: 'Authentication successful. Welcome Director Er. Alifer Sir.',
  });
});

app.get('/api/admin/verify', (req, res) => {
  if (getAdminSession(req)) {
    return res.json({
      authenticated: true,
      director: 'Er. Alifer Sir',
    });
  }

  return res.status(401).json({
    authenticated: false,
    error: 'Unauthorized',
  });
});

app.post('/api/admin/logout', (req, res) => {
  for (const token of getAdminSessionTokens(req)) {
    adminSessions.delete(token);
  }

  const secureFlag =
    process.env.NODE_ENV === 'production' ? '; Secure' : '';

  res.setHeader(
    'Set-Cookie',
    `${ADMIN_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureFlag}`
  );

  return res.json({ success: true });
});

// ==========================================
// 2. CATEGORIES MANAGEMENT ENDPOINTS
// ==========================================

app.get('/api/categories', (_req, res) => {
  const categoriesWithCounts = dataStore.categories
    .map((cat) => {
      const activeCoursesCount = dataStore.courses.filter(
        (c) => c.categoryId === cat.id && c.isActive !== false
      ).length;

      return {
        ...cat,
        courseCount: activeCoursesCount,
      };
    })
    .sort((a, b) => (a.order || 0) - (b.order || 0));

  res.json(categoriesWithCounts);
});

app.post('/api/categories', requireAdmin, (req, res) => {
  const {
    name,
    group,
    description,
    thumbnailUrl,
    badge,
    order,
    isActive,
  } = req.body;

  if (!name || !name.trim()) {
    return res.status(400).json({
      error: 'Category name is required',
    });
  }

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

  const id = `cat-${slug || 'custom'}-${Date.now().toString().slice(-4)}`;

  const newCategory = {
    id,
    name: name.trim(),
    group: group || 'Competitive Examinations',
    description:
      description ||
      'Specialized academic batch curriculum curated by Er. Alifer Sir.',
    thumbnailUrl:
      thumbnailUrl ||
      '/assets/aistudio/Codex_Image_Nov_9__2026__05_42_23_PM_40be101d.jpg',
    order: typeof order === 'number'
      ? order
      : dataStore.categories.length + 1,
    isActive: isActive !== false,
    badge: badge || 'New Batch',
    courseCount: 0,
  };

  dataStore.categories.push(newCategory);
  saveDataStore();

  res.status(201).json(newCategory);
});

app.put('/api/categories/:id', requireAdmin, (req, res) => {
  const { id } = req.params;

  const idx = dataStore.categories.findIndex((c) => c.id === id);

  if (idx === -1) {
    return res.status(404).json({
      error: 'Category not found',
    });
  }

  dataStore.categories[idx] = {
    ...dataStore.categories[idx],
    ...req.body,
    id,
  };

  if (req.body.name || req.body.group) {
    dataStore.courses = dataStore.courses.map((course) => {
      if (course.categoryId === id) {
        return {
          ...course,
          categoryName: req.body.name || course.categoryName,
          categoryGroup: req.body.group || course.categoryGroup,
        };
      }

      return course;
    });
  }

  saveDataStore();
  res.json(dataStore.categories[idx]);
});

app.patch('/api/categories/:id/toggle-active', requireAdmin, (req, res) => {
  const { id } = req.params;

  const cat = dataStore.categories.find((c) => c.id === id);

  if (!cat) {
    return res.status(404).json({
      error: 'Category not found',
    });
  }

  cat.isActive = !cat.isActive;

  saveDataStore();
  res.json(cat);
});

app.post('/api/categories/reorder', requireAdmin, (req, res) => {
  const { orderedIds } = req.body;

  if (Array.isArray(orderedIds)) {
    orderedIds.forEach((id: string, index: number) => {
      const cat = dataStore.categories.find((c) => c.id === id);

      if (cat) {
        cat.order = index + 1;
      }
    });

    dataStore.categories.sort((a, b) => a.order - b.order);
    saveDataStore();
  }

  res.json(dataStore.categories);
});

app.delete('/api/categories/:id', requireAdmin, (req, res) => {
  const { id } = req.params;

  const cat = dataStore.categories.find((c) => c.id === id);

  if (!cat) {
    return res.status(404).json({
      error: 'Category not found',
    });
  }

  const matchingCourses = dataStore.courses.filter(
    (c) => c.categoryId === id
  );

  if (matchingCourses.length > 0) {
    return res.status(400).json({
      error: `Cannot delete category "${cat.name}". It contains ${matchingCourses.length} course(s). Please reassign or delete these courses first before deleting the category.`,
      courseCount: matchingCourses.length,
      courses: matchingCourses.map((c) => ({
        id: c.id,
        title: c.title,
      })),
    });
  }

  dataStore.categories = dataStore.categories.filter((c) => c.id !== id);

  saveDataStore();

  res.json({
    success: true,
    message: `Category "${cat.name}" has been deleted.`,
  });
});

// ==========================================
// 3. COURSES MANAGEMENT ENDPOINTS
// ==========================================

app.get('/api/courses', (req, res) => {
  const { categoryId, publishedOnly } = req.query;

  let results = [...dataStore.courses];

  if (categoryId) {
    results = results.filter((c) => c.categoryId === categoryId);
  }

  if (publishedOnly === 'true') {
    results = results.filter(
      (c) => c.isPublished !== false && c.isActive !== false
    );
  }

  res.json(results);
});

app.post('/api/courses', requireAdmin, (req, res) => {
  const courseData = req.body;

  if (!courseData.title || !courseData.categoryId) {
    return res.status(400).json({
      error: 'Course title and categoryId are required',
    });
  }

  const category = dataStore.categories.find(
    (c) => c.id === courseData.categoryId
  );

  const newCourse = {
    id: courseData.id || `course-${Date.now()}`,
    title: courseData.title.trim(),
    categoryId: courseData.categoryId,
    categoryName: category?.name || courseData.categoryName || 'General',
    categoryGroup: category?.group || courseData.categoryGroup || 'Higher Education',
    category: courseData.category || 'Mathematics',
    isPublished: courseData.isPublished !== undefined
      ? courseData.isPublished
      : true,
    isActive: courseData.isActive !== undefined
      ? courseData.isActive
      : true,

    instructor: courseData.instructor || {
      name: 'Er. Alifer Sir',
      title: 'Academic Director, Alifer Academy',
      avatarUrl: '/assets/aistudio/IMG-20261106-WA0003_3c0fea6c.jpg',
      experience: '8+ Years Teaching Pedagogy',
      bio: 'Mentored over 50,000 students for competitive, engineering, and board examinations with top rank results.',
    },

    thumbnailUrl:
      courseData.thumbnailUrl ||
      category?.thumbnailUrl ||
      '/assets/aistudio/Codex_Image_Nov_9__2026__05_42_23_PM_40be101d.jpg',

    bannerUrl:
      courseData.bannerUrl ||
      courseData.thumbnailUrl ||
      '/assets/aistudio/Codex_Image_Nov_9__2026__05_42_23_PM_40be101d.jpg',

    price: Number(courseData.price) || 1999,
    originalPrice: Number(courseData.originalPrice) || 4999,
    rating: Number(courseData.rating) || 4.9,
    reviewCount: Number(courseData.reviewCount) || 12,
    duration: courseData.duration || '1 Year',
    durationType: courseData.durationType || 'duration',
    startDate: courseData.startDate || '',
    endDate: courseData.endDate || '',
    durationHours: Number(courseData.durationHours) || 60,
    totalLectures: Number(courseData.totalLectures) || 40,
    totalNotes: Number(courseData.totalNotes) || 20,
    totalTests: Number(courseData.totalTests) || 10,
    level: courseData.level || 'Intermediate',
    language: courseData.language || 'Bilingual (Hinglish + English Notes)',

    description:
      courseData.description ||
      'Comprehensive curriculum covering all syllabus requirements with step-by-step problem walkthroughs.',

    features: courseData.features || [
      'Full Syllabus Video Lectures in High Definition',
      'Downloadable Hand-Written Lecture Notes (PDF)',
      'Chapter-wise Practice Tests with Solutions',
      'Direct Ask-a-Query Doubt Clearing Support',
    ],

    isEnrolled: false,
    progressPercent: 0,
    modules: courseData.modules || [],
  };

  dataStore.courses.push(newCourse);
  saveDataStore();

  res.status(201).json(newCourse);
});

app.put('/api/courses/:id', requireAdmin, (req, res) => {
  const { id } = req.params;

  const idx = dataStore.courses.findIndex((c) => c.id === id);

  if (idx === -1) {
    return res.status(404).json({
      error: 'Course not found',
    });
  }

  let categoryName = dataStore.courses[idx].categoryName;
  let categoryGroup = dataStore.courses[idx].categoryGroup;

  if (
    req.body.categoryId &&
    req.body.categoryId !== dataStore.courses[idx].categoryId
  ) {
    const cat = dataStore.categories.find(
      (c) => c.id === req.body.categoryId
    );

    if (cat) {
      categoryName = cat.name;
      categoryGroup = cat.group;
    }
  }

  dataStore.courses[idx] = {
    ...dataStore.courses[idx],
    ...req.body,
    categoryName,
    categoryGroup,
    id,
  };

  saveDataStore();
  res.json(dataStore.courses[idx]);
});

app.patch('/api/courses/:id/publish', requireAdmin, (req, res) => {
  const { id } = req.params;

  const course = dataStore.courses.find((c) => c.id === id);

  if (!course) {
    return res.status(404).json({
      error: 'Course not found',
    });
  }

  course.isPublished = !course.isPublished;

  saveDataStore();
  res.json(course);
});

app.patch('/api/courses/:id/price', requireAdmin, (req, res) => {
  const { id } = req.params;

  const course = dataStore.courses.find((c) => c.id === id);

  if (!course) {
    return res.status(404).json({
      error: 'Course not found',
    });
  }

  const { price, originalPrice } = req.body;

  if (price !== undefined) course.price = Number(price);
  if (originalPrice !== undefined) course.originalPrice = Number(originalPrice);

  saveDataStore();
  res.json(course);
});

app.delete('/api/courses/:id', requireAdmin, (req, res) => {
  const { id } = req.params;

  dataStore.courses = dataStore.courses.filter((c) => c.id !== id);

  saveDataStore();

  res.json({
    success: true,
    message: 'Course deleted successfully',
  });
});

// ==========================================
// 4. PAYMENTS & ADMISSIONS
// Existing payment routes preserved
// ==========================================

app.post('/api/payments/create-order', async (req, res) => {
  try {
    const {
      courseId,
      studentId,
      studentName,
      studentEmail,
      studentPhone,
      paymentMethod,
    } = req.body;

    if (!courseId) {
      return res.status(400).json({
        error: 'Course ID is required',
      });
    }

    const course = dataStore.courses.find((c) => c.id === courseId);

    if (!course) {
      return res.status(404).json({
        error: 'Course not found',
      });
    }

    const effectiveStudentId = studentId || 'STU-ALF-2026-8841';

    const studentAccessList =
      dataStore.studentCourseAccess[effectiveStudentId] || [];

    if (
      studentAccessList.includes(courseId) ||
      (course.isEnrolled && effectiveStudentId === 'STU-ALF-2026-8841')
    ) {
      return res.status(400).json({
        error: 'You are already enrolled in this course. You can access it directly in My Learning.',
        alreadyEnrolled: true,
      });
    }

    const razorpayKeyId = process.env.RAZORPAY_KEY_ID;
    const razorpaySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!razorpayKeyId || !razorpaySecret) {
      return res.status(503).json({
        error: 'Secure online payments are not configured yet. No payment has been taken.',
      });
    }

    const receiptSeq = (dataStore.transactions.length + 1)
      .toString()
      .padStart(3, '0');

    const receiptNumber = `ALIFER-RCPT-${new Date().getFullYear()}-${receiptSeq}`;

    const amountInPaise = Math.round(Number(course.price) * 100);

    if (!Number.isFinite(amountInPaise) || amountInPaise <= 0) {
      return res.status(400).json({
        error: 'Invalid course amount.',
      });
    }

    const razorpayResponse = await fetch(
      'https://api.razorpay.com/v1/orders',
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${razorpayKeyId}:${razorpaySecret}`).toString('base64')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: amountInPaise,
          currency: 'INR',
          receipt: receiptNumber,
        }),
      }
    );

    const razorpayOrder = await razorpayResponse.json() as any;

    if (!razorpayResponse.ok || !razorpayOrder?.id) {
      console.error(
        '[Razorpay] Order creation failed:',
        razorpayOrder?.error?.description || razorpayResponse.status
      );

      return res.status(502).json({
        error: 'Payment gateway could not create an order. Please try again.',
      });
    }

    const orderId = razorpayOrder.id;

    const discountAmount = Math.max(
      0,
      (course.originalPrice || course.price) - course.price
    );

    const pendingTxn = {
      id: `txn-${Date.now()}`,
      orderId,
      courseId: course.id,
      courseTitle: course.title,
      categoryName: course.categoryName || course.category || 'General',
      studentId: effectiveStudentId,
      studentName: typeof studentName === 'string'
        ? studentName.slice(0, 120)
        : 'Student',
      studentEmail: typeof studentEmail === 'string'
        ? studentEmail.slice(0, 254)
        : '',
      studentPhone: typeof studentPhone === 'string'
        ? studentPhone.slice(0, 30)
        : '',
      amount: course.price,
      originalAmount: course.originalPrice || course.price,
      discountAmount,
      currency: 'INR',
      status: 'pending',
      paymentMethod: paymentMethod || 'upi',
      receiptNumber,
      createdAt: new Date().toISOString(),
      notes: `Alifer Academy Admission Enrollment - ${course.duration || '1 Year'} Access`,
    };

    dataStore.transactions.unshift(pendingTxn);
    saveDataStore();

    res.json({
      success: true,
      orderId,
      amount: course.price,
      currency: 'INR',
      courseTitle: course.title,
      duration: course.duration || '1 Year',
      receiptNumber,
      keyId: razorpayKeyId,
      isSandbox: razorpayKeyId.startsWith('rzp_test_'),
    });
  } catch (err: any) {
    console.error('Payment order creation error:', err);

    res.status(500).json({
      error: err.message || 'Failed to initiate course payment',
    });
  }
});

app.post('/api/payments/verify', (req, res) => {
  try {
    const {
      orderId,
      paymentId,
      signature,
      courseId,
      paymentMethod,
    } = req.body;

    if (!orderId || !paymentId || !signature || !courseId) {
      return res.status(400).json({
        error: 'Order ID, payment ID, course ID and Razorpay signature are required.',
      });
    }

    const txn = dataStore.transactions.find(
      (t) => t.orderId === orderId
    );

    if (!txn) {
      return res.status(404).json({
        error: 'Order record not found in payment system.',
      });
    }

    if (txn.status === 'success') {
      return res.status(409).json({
        error: 'This payment order has already been processed.',
      });
    }

    if (txn.status !== 'pending' || txn.courseId !== courseId) {
      return res.status(400).json({
        error: 'Payment order does not match this course or is no longer pending.',
      });
    }

    const razorpaySecret = process.env.RAZORPAY_KEY_SECRET;

    if (!razorpaySecret) {
      return res.status(503).json({
        error: 'Payment verification is unavailable because Razorpay is not configured.',
      });
    }

    const expectedSignature = crypto
      .createHmac('sha256', razorpaySecret)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    const supplied = String(signature);

    const expectedBuffer = Buffer.from(expectedSignature, 'hex');
    const suppliedBuffer = Buffer.from(supplied, 'hex');

    if (
      suppliedBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)
    ) {
      return res.status(400).json({
        error: 'Payment signature verification failed. Access denied.',
      });
    }

    txn.status = 'success';
    txn.paymentId = paymentId;
    txn.signature = supplied;
    txn.verifiedAt = new Date().toISOString();

    if (paymentMethod) {
      txn.paymentMethod = paymentMethod;
    }

    const effectiveStudentId = txn.studentId;

    dataStore.studentCourseAccess[effectiveStudentId] =
      dataStore.studentCourseAccess[effectiveStudentId] || [];

    if (
      !dataStore.studentCourseAccess[effectiveStudentId].includes(txn.courseId)
    ) {
      dataStore.studentCourseAccess[effectiveStudentId].push(txn.courseId);
    }

    const course = dataStore.courses.find(
      (c) => c.id === txn.courseId
    );

    if (course) {
      course.isEnrolled = true;
      course.progressPercent = course.progressPercent || 5;
    }

    saveDataStore();

    return res.json({
      success: true,
      message: `Payment verified! You are now enrolled in ${txn.courseTitle}.`,
      transaction: txn,
    });
  } catch (err: any) {
    console.error('Payment verification error:', err);

    return res.status(500).json({
      error: 'Payment verification failed.',
    });
  }
});

app.get('/api/payments/history', (req, res) => {
  const { studentId } = req.query;

  const effectiveId = (studentId as string) || 'STU-ALF-2026-8841';

  const list = dataStore.transactions.filter(
    (t) => t.studentId === effectiveId || !studentId
  );

  res.json(list);
});

app.get('/api/payments/all', requireAdmin, (_req, res) => {
  res.json(dataStore.transactions);
});

// ==========================================
// 5. ANNOUNCEMENTS & FESTIVALS ENDPOINTS
// ==========================================

app.get('/api/announcements', (_req, res) => {
  const today = new Date().toISOString().split('T')[0];

  const activeAnnouncements = dataStore.announcements.filter((ann) => {
    if (!ann.isActive) return false;
    if (ann.startDate && ann.startDate > today) return false;
    if (ann.endDate && ann.endDate < today) return false;

    return true;
  });

  res.json(activeAnnouncements);
});

app.get('/api/admin/announcements', requireAdmin, (_req, res) => {
  res.json(dataStore.announcements);
});

app.post('/api/announcements', requireAdmin, (req, res) => {
  const {
    title,
    message,
    bannerUrl,
    type,
    startDate,
    endDate,
    targetAudience,
    popupDisplay,
    ctaText,
    ctaLink,
  } = req.body;

  if (!title || !message) {
    return res.status(400).json({
      error: 'Title and message are required',
    });
  }

  const newAnn = {
    id: `ann-${Date.now()}`,
    title: title.trim(),
    message: message.trim(),
    bannerUrl:
      bannerUrl ||
      '/assets/aistudio/Codex_Image_Nov_9__2026__05_42_23_PM_40be101d.jpg',
    type: type || 'general',
    startDate: startDate || new Date().toISOString().split('T')[0],
    endDate: endDate || '2026-12-31',
    targetAudience: targetAudience || 'all',
    popupDisplay: popupDisplay || 'once',
    isActive: true,
    ctaText: ctaText || 'Learn More',
    ctaLink: ctaLink || '',
    createdAt: new Date().toISOString().split('T')[0],
  };

  dataStore.announcements.unshift(newAnn);
  saveDataStore();

  res.status(201).json(newAnn);
});

app.put('/api/announcements/:id', requireAdmin, (req, res) => {
  const { id } = req.params;

  const idx = dataStore.announcements.findIndex((a) => a.id === id);

  if (idx === -1) {
    return res.status(404).json({
      error: 'Announcement not found',
    });
  }

  dataStore.announcements[idx] = {
    ...dataStore.announcements[idx],
    ...req.body,
    id,
  };

  saveDataStore();
  res.json(dataStore.announcements[idx]);
});

app.patch('/api/announcements/:id/toggle', requireAdmin, (req, res) => {
  const { id } = req.params;

  const ann = dataStore.announcements.find((a) => a.id === id);

  if (!ann) {
    return res.status(404).json({
      error: 'Announcement not found',
    });
  }

  ann.isActive = !ann.isActive;

  saveDataStore();
  res.json(ann);
});

app.delete('/api/announcements/:id', requireAdmin, (req, res) => {
  const { id } = req.params;

  dataStore.announcements = dataStore.announcements.filter(
    (a) => a.id !== id
  );

  saveDataStore();
  res.json({ success: true });
});

// ==========================================
// 5B. NOTIFICATIONS & BROADCAST ALERTS
// ==========================================

app.post('/api/notifications/register-token', (req, res) => {
  try {
    const { token } = req.body;

    if (!token || typeof token !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Valid FCM token is required.',
      });
    }

    if (!dataStore.fcmTokens.includes(token)) {
      dataStore.fcmTokens.push(token);
      saveDataStore();
    }

    return res.status(200).json({
      success: true,
      message: 'FCM token registered successfully.',
    });
  } catch (err: any) {
    console.error('FCM token registration failed:', err);

    return res.status(500).json({
      success: false,
      error: 'Failed to register FCM token.',
    });
  }
});

app.get('/api/notifications', (_req, res) => {
  res.json(dataStore.notifications);
});

app.post('/api/notifications/broadcast', requireAdmin, async (req, res) => {
  try {
    const {
      title,
      message,
      imageUrl,
      type,
    } = req.body;

    if (typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({
        error: 'Alert headline / title is required.',
      });
    }

    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        error: 'Alert message body is required.',
      });
    }

    const cleanImageUrl =
      typeof imageUrl === 'string' && imageUrl.trim()
        ? imageUrl.trim()
        : undefined;

    const newNotification = {
      id: `notif-broadcast-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
      title: title.trim(),
      message: message.trim(),
      imageUrl: cleanImageUrl,
      timestamp: 'Just now',
      type: type || 'announcement',
      read: false,
      createdAt: new Date().toISOString(),
    };

    dataStore.notifications.unshift(newNotification);
    saveDataStore();

    let pushResult = {
      successCount: 0,
      failureCount: 0,
      message: '',
    };

    let pushError = false;

    try {
      const result = await sendPushNotification(
        newNotification.title,
        newNotification.message,
        newNotification.imageUrl
      );

      pushResult = {
        successCount: result.successCount,
        failureCount: result.failureCount,
        message: result.message || '',
      };
    } catch (pushErr) {
      pushError = true;
      console.error('FCM push delivery failed:', pushErr);
    }

    return res.status(201).json({
      success: true,

      message: pushError
        ? 'Broadcast published in the app, but push delivery failed.'
        : pushResult.message === 'No registered devices found.'
          ? 'Broadcast published in the app. No registered devices found.'
          : `Broadcast published. Push notifications sent to ${pushResult.successCount} device(s).`,

      notification: newNotification,

      pushDelivery: {
        successCount: pushResult.successCount,
        failureCount: pushResult.failureCount,
        failed: pushError,
      },
    });
  } catch (err: any) {
    console.error('Error broadcasting notification:', err);

    return res.status(500).json({
      error: err.message || 'Failed to broadcast alert',
    });
  }
});

app.patch('/api/notifications/:id/read', (req, res) => {
  const { id } = req.params;

  const notif = dataStore.notifications.find((n) => n.id === id);

  if (notif) {
    notif.read = true;
    saveDataStore();

    return res.json({
      success: true,
      notification: notif,
    });
  }

  res.status(404).json({
    error: 'Notification not found',
  });
});

app.patch('/api/notifications/mark-all-read', (_req, res) => {
  dataStore.notifications.forEach((n) => {
    n.read = true;
  });

  saveDataStore();

  res.json({
    success: true,
    count: dataStore.notifications.length,
  });
});

// ==========================================
// 6. STUDENT QUERIES & DOUBTS
// ==========================================

app.post('/api/queries', (req, res) => {
  const {
    courseId,
    lectureId,
    studentName,
    studentAvatar,
    question,
    imageUrl,
  } = req.body;

  if (!question) {
    return res.status(400).json({
      error: 'Question text is required',
    });
  }

  const newQuery = {
    id: `query-${Date.now()}`,
    lectureId: lectureId || 'general',
    studentName: studentName || 'Student',
    studentAvatar: studentAvatar || '',
    question: question.trim(),
    imageUrl,
    timestamp: 'Just now',
    status: 'pending',
    likes: 0,
  };

  dataStore.queries.unshift(newQuery);

  if (courseId && lectureId) {
    const course = dataStore.courses.find(
      (c) => c.id === courseId
    );

    if (course) {
      for (const mod of course.modules || []) {
        for (const chap of mod.chapters || []) {
          const lec = chap.lectures.find(
            (l: any) => l.id === lectureId
          );

          if (lec) {
            lec.queries = lec.queries || [];
            lec.queries.unshift(newQuery);
            break;
          }
        }
      }
    }
  }

  saveDataStore();

  res.status(201).json(newQuery);
});

app.post('/api/queries/:queryId/reply', requireAdmin, (req, res) => {
  const { queryId } = req.params;
  const { replyText, author } = req.body;

  if (!replyText) {
    return res.status(400).json({
      error: 'Reply text is required',
    });
  }

  const query = dataStore.queries.find(
    (q) => q.id === queryId
  );

  if (query) {
    query.status = 'answered';

    query.teacherReply = {
      author: author || 'Er. Alifer Sir',
      text: replyText.trim(),
      timestamp: 'Just now',
    };
  }

  for (const course of dataStore.courses) {
    for (const mod of course.modules || []) {
      for (const chap of mod.chapters || []) {
        for (const lec of chap.lectures || []) {
          const found = (lec.queries || []).find(
            (q: any) => q.id === queryId
          );

          if (found) {
            found.status = 'answered';

            found.teacherReply = {
              author: author || 'Er. Alifer Sir',
              text: replyText.trim(),
              timestamp: 'Just now',
            };
          }
        }
      }
    }
  }

  saveDataStore();

  res.json({
    success: true,
    query,
  });
});

// ==========================================
// START SERVER
// ==========================================

async function startServer() {
  const isProduction = process.env.NODE_ENV === 'production';

  if (!isProduction) {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
      },
      appType: 'spa',
    });

    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');

    app.use(express.static(distPath));

    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `[Alifer Academy] Server listening on http://0.0.0.0:${PORT}`
    );
  });
}

startServer();