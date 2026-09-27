import { useState, useEffect, useRef } from 'react';

export function useNetworkStatus() {
  const [isOnline, setIsOnline] = useState(() => 
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [lastChangedAt, setLastChangedAt] = useState(() => new Date().toISOString());
  const wasOfflineRef = useRef(false);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      setLastChangedAt(new Date().toISOString());
    };
    const handleOffline = () => {
      wasOfflineRef.current = true;
      setIsOnline(false);
      setLastChangedAt(new Date().toISOString());
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return { isOnline, lastChangedAt, wasOffline: wasOfflineRef.current };
}

