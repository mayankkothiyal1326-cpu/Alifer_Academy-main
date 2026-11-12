import { initializeApp, getApps, getApp } from "firebase/app";
import {
  getMessaging,
  isSupported,
  type Messaging,
} from "firebase/messaging";

const firebaseConfig = {
  apiKey: "AIzaSyDDH6JfaJhviZUm3LB6sT95Iw-1IQkjGec",
  authDomain: "alifer-academy-58413.firebaseapp.com",
  projectId: "alifer-academy-58413",
  storageBucket: "alifer-academy-58413.firebasestorage.app",
  messagingSenderId: "737404511632",
  appId: "1:737404511632:web:5c56844bdcbe0afa757f15",
};

const app = getApps().length
  ? getApp()
  : initializeApp(firebaseConfig);

export const messagingPromise: Promise<Messaging | null> =
  isSupported()
    .then((supported) => (supported ? getMessaging(app) : null))
    .catch(() => null);

export default app;