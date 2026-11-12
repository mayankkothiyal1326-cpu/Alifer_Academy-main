importScripts("https://www.gstatic.com/firebasejs/13.2.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/13.2.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyDDH6JfaJhviZUm3LB6sT95Iw-1IQkjGec",
  authDomain: "alifer-academy-58413.firebaseapp.com",
  projectId: "alifer-academy-58413",
  storageBucket: "alifer-academy-58413.firebasestorage.app",
  messagingSenderId: "737404511632",
  appId: "1:737404511632:web:5c56844bdcbe0afa757f15"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || "Alifer Academy";

  self.registration.showNotification(title, {
    body: payload.notification?.body || "You have a new notification.",
    icon: "/favicon.ico"
  });
});