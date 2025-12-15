
import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase, getGlobalMessages, insertGlobalMessage } from '../lib/supabase';
import { Message, UserProfile } from '../types';

export const useGlobalChat = (userProfile: UserProfile | null, myPeerId: string | null) => {
  const [globalMessages, setGlobalMessages] = useState<Message[]>(() => {
     // Initialize from LocalStorage for instant display
     if (typeof window !== 'undefined') {
        try {
           const saved = localStorage.getItem('global_meet_messages');
           if (saved) return JSON.parse(saved);
        } catch(e) {}
     }
     return [];
  });
  
  const [isReady, setIsReady] = useState(false);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // Persistence: Save to LocalStorage whenever messages change
  useEffect(() => {
     try {
        localStorage.setItem('global_meet_messages', JSON.stringify(globalMessages));
     } catch(e) {}
  }, [globalMessages]);

  // 1. Initial History Load (Newest First)
  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const data = await getGlobalMessages();
      if (!mounted) return;
      
      // DB returns Newest First (DESC). We keep it that way for Feed Style.
      const formatted: Message[] = data.map((row: any) => ({
        id: row.id.toString(),
        text: row.content,
        sender: row.sender_id === myPeerId ? 'me' : 'stranger',
        senderName: row.sender_name,
        senderPeerId: row.sender_id,
        senderProfile: row.sender_profile,
        timestamp: new Date(row.created_at).getTime(),
        type: 'text'
      }));
      
      setGlobalMessages(prev => {
         // Deduplicate
         const existingIds = new Set(prev.map(m => m.id));
         const newMsgs = formatted.filter(m => !existingIds.has(m.id));
         if (newMsgs.length === 0) return prev;
         
         // Combine: New DB messages + Existing Local messages
         // Since DB is newest first, we put them at the front, but we need to merge carefully.
         // Simpler strategy for initial load: Just take DB messages if local is stale, or merge.
         // For feed style (Newest Top): [Newest ... Oldest]
         
         const combined = [...newMsgs, ...prev].sort((a,b) => b.timestamp - a.timestamp);
         
         // Limit to 50 messages (Auto-vanish older ones)
         return combined.slice(0, 50);
      });
      setIsReady(true);
    };
    load();
    return () => { mounted = false; };
  }, [myPeerId]);

  // 2. Realtime Subscription (Broadcast + DB Sync)
  useEffect(() => {
    const channel = supabase.channel('global-meet-v3');
    channelRef.current = channel;

    channel
      .on('broadcast', { event: 'message' }, (payload) => {
         const msg = payload.payload as Message;
         // Ignore my own broadcasts to prevent duplication
         if (msg.senderPeerId === myPeerId) return;

         setGlobalMessages(prev => {
            if (prev.some(m => m.id === msg.id)) return prev;
            // Newest at Top + Limit 50
            return [{ ...msg, sender: 'stranger' } as Message, ...prev].slice(0, 50);
         });
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') setIsReady(true);
      });

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
    };
  }, [myPeerId]);

  // 3. Send Message (Optimistic Broadcast)
  const sendGlobalMessage = useCallback(async (text: string) => {
    if (!userProfile || !myPeerId) return;

    const tempId = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    const newMessage: Message = {
      id: tempId,
      text: text,
      sender: 'me',
      senderName: userProfile.username,
      senderPeerId: myPeerId,
      senderProfile: userProfile,
      timestamp: Date.now(),
      type: 'text'
    };

    // A. Optimistic Local Update (Newest at Top + Limit 50)
    setGlobalMessages(prev => [newMessage, ...prev].slice(0, 50));

    // B. Instant Broadcast to others
    if (channelRef.current) {
      channelRef.current.send({
        type: 'broadcast',
        event: 'message',
        payload: newMessage
      });
    }

    // C. Background DB Insert (Persistence)
    insertGlobalMessage(text, userProfile, myPeerId);

  }, [userProfile, myPeerId]);

  return {
    globalMessages,
    sendGlobalMessage,
    isReady
  };
};
