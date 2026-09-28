/**
 * Firebase 웹 설정. 빌드 시 환경 변수(VITE_FIREBASE_*)에서 읽는다 (.env.production 참고).
 * 웹 설정값은 공개돼도 되는 식별자다 — 실제 보호는 firestore.rules가 한다.
 * 값이 없으면 온라인 기능은 숨기고 게임은 오프라인으로만 동작한다.
 */
export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  storageBucket?: string;
  messagingSenderId?: string;
}

const env = import.meta.env as Record<string, string | undefined>;

export const firebaseConfig: FirebaseWebConfig | null =
  env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_PROJECT_ID && env.VITE_FIREBASE_APP_ID
    ? {
        apiKey: env.VITE_FIREBASE_API_KEY,
        authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || `${env.VITE_FIREBASE_PROJECT_ID}.firebaseapp.com`,
        projectId: env.VITE_FIREBASE_PROJECT_ID,
        appId: env.VITE_FIREBASE_APP_ID,
        storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
        messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
      }
    : null;

/** 온라인 기능을 쓸 수 있는 환경인가 (설정이 있고, 임베드 뷰어 안이 아님). */
export function onlineAvailable(): boolean {
  if (!firebaseConfig) return false;
  // claude.ai 아티팩트 같은 샌드박스 iframe에서는 로그인·외부 연결이 막힌다
  try {
    if (window.top !== window.self) return false;
  } catch {
    return false;
  }
  return true;
}
