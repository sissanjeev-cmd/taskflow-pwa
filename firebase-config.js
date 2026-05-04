// ── TaskFlow Firebase Configuration ────────────────────────────────────────
// Follow these steps to get your values:
//
// 1. Go to https://console.firebase.google.com
// 2. Click "Add project" (or select an existing one)
// 3. In the left sidebar: Authentication → Sign-in method → Enable "Google"
// 4. In the left sidebar: Firestore Database → Create database → Production mode
//    (choose the region closest to you, e.g. nam5 for US)
// 5. Firestore → Rules tab → paste the rules below → Publish
// 6. Project Settings (gear icon) → Your apps → Add app → Web (</>)
//    Copy the firebaseConfig values and paste below
//
// ── Firestore Security Rules ────────────────────────────────────────────────
// rules_version = '2';
// service cloud.firestore {
//   match /databases/{database}/documents {
//     match /users/{userId}/tasks/{taskId} {
//       allow read, write: if request.auth != null && request.auth.uid == userId;
//     }
//   }
// }
// ────────────────────────────────────────────────────────────────────────────

export const firebaseConfig = {
  apiKey:            "REPLACE_WITH_YOUR_API_KEY",
  authDomain:        "REPLACE_WITH_YOUR_PROJECT_ID.firebaseapp.com",
  projectId:         "REPLACE_WITH_YOUR_PROJECT_ID",
  storageBucket:     "REPLACE_WITH_YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "REPLACE_WITH_YOUR_SENDER_ID",
  appId:             "REPLACE_WITH_YOUR_APP_ID"
};
