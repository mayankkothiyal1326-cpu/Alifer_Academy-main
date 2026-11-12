import { getToken } from "firebase/messaging";
import { messagingPromise } from "./firebase";

const VAPID_KEY =
  "BD1T55S5Yy3OqwIaDN0kTWYTI0CiJvKr4IGM3pnrUeO_ILMtKgGfaaJbLEUlgnmgCGx1LiMgMYd5QCZHf1KuQm8";

export async function requestNotificationPermission() {
  try {
    if (!("Notification" in window)) {
      console.warn("This browser does not support notifications.");
      return null;
    }

    const permission = await Notification.requestPermission();

    if (permission !== "granted") {
      return null;
    }

    const messaging = await messagingPromise;

    if (!messaging) {
      return null;
    }

    const registration = await navigator.serviceWorker.register(
      "/firebase-messaging-sw.js"
    );

    const token = await getToken(messaging, {
      vapidKey: VAPID_KEY,
      serviceWorkerRegistration: registration,
    });

    if (!token) {
  return null;
}

const response = await fetch("/api/notifications/register-token", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ token }),
});

if (!response.ok) {
  throw new Error("Failed to register FCM token with server.");
}

console.log("FCM token registered successfully.");

return token;
  } catch (error) {
    console.error("Notification setup failed:", error);
    return null;
  }
}