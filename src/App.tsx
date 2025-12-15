import React, { useState, useEffect, useRef, Suspense, useCallback } from 'react';
import { Send, Loader2, RefreshCw, EyeOff, Shield, Image as ImageIcon, Mic, X, Square, AlertTriangle, UserPlus, Check, Bell, Sparkles, MessageCircle, Timer, Infinity } from 'lucide-react';
import { supabase, saveMessageToHistory, fetchChatHistory } from './lib/supabase';
import { Message, ChatMode, UserProfile, AppSettings, SessionType, ReplyInfo } from './types';
import { useHumanChat } from './hooks/useHumanChat';
import { useGlobalChat } from './hooks/useGlobalChat';
import { MessageBubble } from './components/MessageBubble';
import { Button } from './components/Button';
import { Header } from './components/Header';
import { LandingPage } from './components/LandingPage';
import Loader from './components/Loader';
import { ImageViewer } from './components/ImageViewer';
import { ImageConfirmationModal } from './components/ImageConfirmationModal';
import { clsx } from 'clsx';

// Lazy Load Heavy Components to reduce initial bundle size
const JoinModal = React.lazy(() => import('./components/JoinModal').then(module => ({ default: module.JoinModal })));
const SettingsModal = React.lazy(() => import('./components/SettingsModal').then(module => ({ default: module.SettingsModal })));
const SocialHub = React.lazy(() => import('./components/SocialHub').then(module => ({ default: module.SocialHub })));
const EditMessageModal = React.lazy(() => import('./components/EditMessageModal').then(module => ({ default: module.EditMessageModal })));

const getStoredUserId = () => {
  if (typeof window === 'undefined') return 'server_user';
  let id = localStorage.getItem('chat_user_id');
  if (!id) {
    id = 'user_' + Math.random().toString(36).substr(2, 9);
    localStorage.setItem('chat_user_id', id);
  }
  return id;
};

const getInitialTheme = (): 'light' | 'dark' => {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('chat_theme') as 'light' | 'dark';
    if (saved) return saved;
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
  }
  return 'dark';
};

const LOADING_TEXTS = [
  "Finding a stranger with similar vibes...",
  "Looking for someone you’ll vibe with...",
  "Get ready to meet someone new!"
];

export default function App() {
  const [theme, setTheme] = useState<'light' | 'dark'>(getInitialTheme);
  const [showJoinModal, setShowJoinModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showEditProfileModal, setShowEditProfileModal] = useState(false);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [inputText, setInputText] = useState('');
  
  const [settings, setSettings] = useState<AppSettings>({ vanishMode: false });
  const [sessionType, setSessionType] = useState<SessionType>('random');
  const [editingMessage, setEditingMessage] = useState<{id: string, text: string} | null>(null);
  const [friendNotification, setFriendNotification] = useState<string | null>(null);
  const [hasChatted, setHasChatted] = useState(false);
  const [showSafetyWarning, setShowSafetyWarning] = useState(false);
  const [replyingTo, setReplyingTo] = useState<ReplyInfo | null>(null);
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [localNotification, setLocalNotification] = useState<string | null>(null);
  const [loadingTextIndex, setLoadingTextIndex] = useState(0);
  
  const [isRecording, setIsRecording] = useState(false);
  
  // Stable ID for friend matching
  const userId = useRef(getStoredUserId()).current;

  // We do NOT pass a persistent PeerID anymore. 
  // We let PeerJS generate a random ID every session/tab to prevent collisions that cause disconnects.
  // Instead, we use `userId` inside the profile for stable friend identification.
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  
  const prevOnlineUserIds = useRef<Set<string>>(new Set());

  const { 
    messages, setMessages, status, partnerTyping, partnerRecording, partnerProfile, partnerPeerId, remoteVanishMode,
    onlineUsers, myPeerId, error, friends, friendRequests, removeFriend, incomingReaction, incomingDirectMessage, incomingDirectStatus, isPeerConnected,
    sendMessage, sendDirectMessage, sendDirectImage, sendDirectAudio, sendDirectTyping, sendDirectFriendRequest, sendDirectReaction,
    sendImage, sendAudio, sendReaction, editMessage, sendTyping, sendRecording, updateMyProfile, sendVanishMode,
    sendFriendRequest, acceptFriendRequest, rejectFriendRequest, connect, callPeer, disconnect,
    disconnectReason, notification
  } = useHumanChat(userProfile, undefined); // Pass undefined to generate random Peer ID

  const { globalMessages, sendGlobalMessage } = useGlobalChat(userProfile, myPeerId);

  useEffect(() => {
    const savedProfile = localStorage.getItem('chat_user_profile');
    if (savedProfile) {
      try {
        const parsed = JSON.parse(savedProfile);
        // Ensure profile has the stable userId
        if (!parsed.uid) parsed.uid = userId;
        setUserProfile(parsed);
      } catch (e) {
        console.error("Failed to load profile", e);
      }
    }
  }, [userId]);

  useEffect(() => {
    if (remoteVanishMode !== null && remoteVanishMode !== undefined) {
      setSettings(prev => ({ ...prev, vanishMode: remoteVanishMode }));
    }
  }, [remoteVanishMode]);

  useEffect(() => {
    if (status === ChatMode.CONNECTED) {
      setHasChatted(true);
      setShowSafetyWarning(true);
      const timer = setTimeout(() => setShowSafetyWarning(false), 8000); // Auto hide after 8s
      return () => clearTimeout(timer);
    } else {
      setShowSafetyWarning(false);
      setReplyingTo(null);
    }
  }, [status]);

  // Loading text cycle effect
  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (status === ChatMode.SEARCHING || status === ChatMode.WAITING) {
      interval = setInterval(() => {
        setLoadingTextIndex((prev) => (prev + 1) % LOADING_TEXTS.length);
      }, 2500); // Change text every 2.5 seconds
    } else {
      setLoadingTextIndex(0);
    }
    return () => clearInterval(interval);
  }, [status]);

  useEffect(() => {
    const interval = setInterval(() => {
      // Logic for vanish mode text messages
      if (messages.some(m => m.isVanish)) {
        const now = Date.now();
        setMessages(prev => prev.filter(msg => {
          if (!msg.isVanish) return true;
          return (now - msg.timestamp) < 10000;
        }));
      }
      
      // We don't remove expired images from state immediately to allow "expired" placeholder,
      // but we could clean them up if they get too old.
    }, 1000);
    return () => clearInterval(interval);
  }, [messages, setMessages]);

  useEffect(() => {
    const loadHistory = async () => { await fetchChatHistory(userId); };
    loadHistory();
  }, [userId]);

  useEffect(() => {
    const lastMsg = messages[messages.length - 1];
    if (lastMsg && lastMsg.sender === 'me' && !settings.vanishMode) {
       saveMessageToHistory(userId, lastMsg);
    }
  }, [messages, userId, settings.vanishMode]);

  useEffect(() => {
    if (theme === 'dark') document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, [theme]);

  // Clear local notification after 3s
  useEffect(() => {
    if (localNotification) {
      const timer = setTimeout(() => setLocalNotification(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [localNotification]);

  const toggleTheme = () => {
    setTheme(prev => {
      const newTheme = prev === 'dark' ? 'light' : 'dark';
      localStorage.setItem('chat_theme', newTheme);
      return newTheme;
    });
  };

  useEffect(() => {
    if (!userProfile) return;
    const currentOnlineIds = new Set(onlineUsers.map(u => u.peerId));
    if (friends.length > 0) {
      friends.forEach(friend => {
        // Match by UID if available, else fallback to ID
        const isOnline = onlineUsers.some(u => 
           (u.profile?.uid && friend.profile.uid && u.profile.uid === friend.profile.uid) ||
           u.peerId === friend.id
        );

        if (isOnline) {
           // We need to track notification state to avoid spam, using a stable ID if possible
           const trackId = friend.profile.uid || friend.id;
           if (!prevOnlineUserIds.current.has(trackId)) {
              setFriendNotification(`${friend.profile.username} is now online!`);
              setTimeout(() => setFriendNotification(null), 4000);
           }
        }
      });
    }
    
    // Update tracking set
    const newTrackSet = new Set<string>();
    onlineUsers.forEach(u => newTrackSet.add(u.profile?.uid || u.peerId));
    prevOnlineUserIds.current = newTrackSet;
    
  }, [onlineUsers, friends, userProfile]);

  useEffect(() => {
    if (sessionType === 'random') {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, partnerTyping, partnerRecording, sessionType, status]);

  const handleStartClick = () => setShowJoinModal(true);

  const handleJoin = (profile: UserProfile) => {
    // Inject stable ID
    const profileWithId = { ...profile, uid: userId };
    localStorage.setItem('chat_user_profile', JSON.stringify(profileWithId));
    setUserProfile(profileWithId);
    setShowJoinModal(false);
    setSessionType('random');
  };

  const handleUpdateProfile = (profile: UserProfile) => {
    const profileWithId = { ...profile, uid: userId };
    localStorage.setItem('chat_user_profile', JSON.stringify(profileWithId));
    setUserProfile(profileWithId);
    updateMyProfile(profileWithId);
    setShowEditProfileModal(false);
  };

  const handleUpdateSettings = (newSettings: AppSettings) => {
    // Check if vanish mode changed to show notification
    if (newSettings.vanishMode !== settings.vanishMode) {
       setLocalNotification(newSettings.vanishMode ? "Vanish Mode Enabled" : "Vanish Mode Disabled");
       sendVanishMode(newSettings.vanishMode);
    }
    setSettings(newSettings);
  };

  const handleDirectCall = (peerId: string, profile?: UserProfile) => {
    callPeer(peerId, profile);
  };

  const handleSendMessage = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputText.trim()) return;
    sendMessage(inputText, replyingTo || undefined, settings.vanishMode);
    if (settings.vanishMode) {
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last && last.sender === 'me') {
           const updated = [...prev];
           updated[updated.length - 1] = { ...last, isVanish: true };
           return updated;
        }
        return prev;
      });
    }
    sendTyping(false);
    setInputText('');
    setReplyingTo(null);
  };

  const handleTyping = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (showSafetyWarning) setShowSafetyWarning(false);
    setInputText(e.target.value);
    sendTyping(true);
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    typingTimeoutRef.current = setTimeout(() => sendTyping(false), 1000);
  };

  const handleNewChat = () => {
    setSessionType('random'); 
    disconnect();
    setTimeout(() => {
       connect();
    }, 100);
  };

  const initiateEdit = useCallback((id: string, text: string) => { setEditingMessage({ id, text }); }, []);

  const saveEditedMessage = (newText: string) => {
    if (editingMessage) {
      editMessage(editingMessage.id, newText);
      setEditingMessage(null);
    }
  };

  const handleReply = useCallback((msg: Message) => {
      setReplyingTo({
         id: msg.id,
         text: msg.text || (msg.type === 'image' ? 'Image' : 'Audio'),
         senderName: msg.sender === 'me' ? 'You' : (partnerProfile?.username || 'Stranger')
      });
  }, [partnerProfile]);

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        // Compress Image Logic
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let width = img.width;
          let height = img.height;
          
          // Max dimension 800px for faster P2P transfer
          const MAX_SIZE = 800;
          if (width > height) {
            if (width > MAX_SIZE) {
              height *= MAX_SIZE / width;
              width = MAX_SIZE;
            }
          } else {
            if (height > MAX_SIZE) {
              width *= MAX_SIZE / height;
              height = MAX_SIZE;
            }
          }
          
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx?.drawImage(img, 0, 0, width, height);
          
          // Compress to JPEG 0.6 quality
          const compressedBase64 = canvas.toDataURL('image/jpeg', 0.6);
          setPendingImage(compressedBase64);
        };
        img.src = event.target?.result as string;
      };
      reader.readAsDataURL(file);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleConfirmImage = (expiryDuration: number) => {
    if (pendingImage) {
      sendImage(pendingImage, expiryDuration > 0 ? expiryDuration : undefined, settings.vanishMode);
      setPendingImage(null);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = () => {
           sendAudio(reader.result as string, settings.vanishMode);
        };
        stream.getTracks().forEach(track => track.stop());
      };
      mediaRecorder.start();
      setIsRecording(true);
      sendRecording(true);
    } catch (err) {
      console.error("Error accessing microphone:", err);
      alert("Could not access microphone.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      sendRecording(false);
    }
  };

  const isConnected = status === ChatMode.CONNECTED;
  const isSearching = status === ChatMode.SEARCHING || status === ChatMode.WAITING;
  
  // Robust check for friendship status
  const isCurrentPartnerFriend = partnerPeerId ? friends.some(f => 
    f.id === partnerPeerId || 
    (f.profile.uid && partnerProfile?.uid && f.profile.uid === partnerProfile.uid)
  ) : false;

  const getDisconnectMessage = () => {
    if (disconnectReason === 'local_network') return "You disconnected due to an internet issue.";
    if (status === ChatMode.IDLE) return "You ended the chat.";
    
    switch (disconnectReason) {
      case 'explicit': return "The user ended the chat.";
      case 'network': return "The user disconnected due to an internet issue.";
      case 'inactive': return "The user went offline.";
      default: return "The user ended the chat.";
    }
  };

  const renderMainContent = () => {
    if (status === ChatMode.IDLE && !userProfile) {
      return (
        <LandingPage 
          onlineCount={onlineUsers.length} 
          onStart={handleStartClick} 
          theme={theme}
          toggleTheme={toggleTheme}
        />
      );
    }

    return (
      <div className="flex-1 flex flex-col h-full relative overflow-hidden">
         {/* SEARCHING OVERLAY */}
         {isSearching && (
           <div className="absolute inset-0 z-30 bg-slate-50 dark:bg-slate-950 flex flex-col items-center justify-center p-6 text-center animate-in fade-in duration-300">
             <div className="relative mb-8"><Loader /></div>
             <h2 className="text-3xl font-bold text-slate-900 dark:text-white mb-3">Matching you...</h2>
             <p className="text-slate-500 dark:text-slate-400 max-w-xs mx-auto animate-pulse mb-8 min-h-[48px] flex items-center justify-center transition-all duration-300">
                {LOADING_TEXTS[loadingTextIndex]}
             </p>
             <div className="flex flex-wrap justify-center gap-2 max-w-sm mx-auto mb-12">
                {userProfile?.interests.map(i => (
                   <span key={i} className="px-3 py-1 bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 rounded-full text-xs font-medium">{i}</span>
                ))}
             </div>
             <Button variant="secondary" onClick={() => { disconnect(); }}>Cancel</Button>
           </div>
         )}

        {/* SAFETY WARNING */}
        {showSafetyWarning && isConnected && (
             <div className="absolute top-4 left-0 right-0 z-50 flex justify-center px-4 animate-in fade-in slide-in-from-top-2 duration-500 pointer-events-none">
                <div className="bg-amber-500/10 backdrop-blur-md border border-amber-500/20 text-amber-600 dark:text-amber-400 px-4 py-2 rounded-full text-xs font-bold shadow-lg flex items-center gap-2">
                  <Shield size={14} /> Beware: Do not share personal info.
                </div>
             </div>
        )}

        <div className={clsx(
          "flex-1 overflow-y-auto p-4 sm:p-6 space-y-2 w-full max-w-4xl mx-auto z-10 relative scroll-smooth",
          (messages.length === 0 && (status === ChatMode.DISCONNECTED || status === ChatMode.IDLE)) && "flex flex-col justify-center"
        )}>
          {/* Messages */}
          {messages.map((msg) => (
              <div key={msg.id} className={clsx("transition-opacity duration-1000", msg.isVanish && "animate-pulse")}>
                <MessageBubble 
                    message={msg} 
                    senderName={partnerProfile?.username} 
                    onReact={(emoji) => sendReaction(msg.id, emoji)}
                    onEdit={initiateEdit}
                    onReply={handleReply}
                    onImageClick={setPreviewImage}
                />
              </div>
          ))}

          {(status === ChatMode.DISCONNECTED || status === ChatMode.IDLE) && !isSearching && (
              <div className={clsx(
                "flex flex-col items-center gap-6 animate-in fade-in zoom-in-95",
                messages.length > 0 ? "py-8 mt-8 border-t border-slate-100 dark:border-white/5 pt-8" : "w-full"
              )}>
                {hasChatted ? (
                  <>
                    <div className="w-20 h-20 bg-red-50 dark:bg-red-900/10 rounded-full flex items-center justify-center text-red-500 mb-2">
                      <X size={40} />
                    </div>
                    <div className="text-center space-y-2">
                      <h3 className="text-2xl font-bold text-slate-900 dark:text-white">Chat Ended</h3>
                      <p className="text-slate-500 dark:text-slate-400 text-base max-w-xs mx-auto">
                        {getDisconnectMessage()}
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-center space-y-2">
                      <h3 className="text-2xl font-bold text-slate-900 dark:text-white">Start Matching</h3>
                      <p className="text-slate-500 dark:text-slate-400 text-base max-w-xs mx-auto">
                        Connect with random people anonymously.
                      </p>
                    </div>
                  </>
                )}
                
                <Button onClick={handleNewChat} className="shadow-lg shadow-brand-500/20 px-8 py-4 text-lg rounded-2xl w-full sm:w-auto">
                   <RefreshCw size={20} /> Find New Stranger
                </Button>
              </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className={clsx(
          "border-t shrink-0 w-full z-20 pb-[env(safe-area-inset-bottom)] transition-colors relative",
          settings.vanishMode ? "bg-[#1a0b2e] dark:bg-[#1a0b2e] border-purple-500/30" : "bg-white dark:bg-slate-900 border-slate-200 dark:border-white/5",
          (!isConnected && !isSearching) && "opacity-100", 
          isSearching && "invisible" 
        )}>
          
          <div className={clsx("max-w-4xl mx-auto p-2 sm:p-4", isSearching && "pointer-events-none")}>
            {/* Status Indicators (Typing / Recording) */}
            {(partnerTyping || partnerRecording) && (
              <div className="h-5 px-4 mb-1 text-xs text-brand-500 font-medium flex items-center gap-2">
                 {partnerTyping && (
                   <span className="animate-pulse">typing...</span>
                 )}
                 {!partnerTyping && partnerRecording && (
                    <span className="animate-pulse flex items-center gap-1">
                       <Mic size={12} className="animate-bounce" /> recording audio...
                    </span>
                 )}
              </div>
            )}
            
            {/* Replying To Banner */}
            {replyingTo && (
              <div className="flex items-center justify-between bg-slate-100 dark:bg-white/10 p-2 rounded-lg border-l-4 border-brand-500 mb-2 animate-in slide-in-from-bottom-2">
                 <div className="text-xs truncate max-w-[80%]">
                    <div className="font-bold text-brand-600 dark:text-brand-400">Replying to {replyingTo.senderName}</div>
                    <div className="text-slate-600 dark:text-slate-300 truncate">{replyingTo.text}</div>
                 </div>
                 <button type="button" onClick={() => setReplyingTo(null)} className="p-1 hover:bg-slate-200 dark:hover:bg-white/20 rounded-full"><X size={14}/></button>
              </div>
            )}

            <form onSubmit={handleSendMessage} className="flex gap-2 items-end relative">
              <div id="social-hub-trigger-anchor" className="absolute bottom-[calc(100%+8px)] right-0 z-30 w-12 h-12 pointer-events-none"></div>
              
              {/* Image Input */}
              <div className="flex flex-col items-center gap-1 shrink-0">
                 <input type="file" accept="image/*" className="hidden" ref={fileInputRef} onChange={handleImageUpload} disabled={!isConnected}/>
                 <button type="button" onClick={() => fileInputRef.current?.click()} className="p-3 text-slate-400 hover:text-brand-500 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-xl transition-all duration-150 active:scale-90 disabled:opacity-50"><ImageIcon size={24} /></button>
              </div>

              {!inputText.trim() && (
                  isRecording ? (
                    <button type="button" onClick={stopRecording} className="p-3 bg-red-500 hover:bg-red-600 text-white rounded-xl shadow-lg shadow-red-500/20 transition-all animate-pulse shrink-0"><Square size={24} fill="currentColor" /></button>
                  ) : (
                    <button type="button" onClick={startRecording} className="p-3 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 text-slate-600 dark:text-slate-200 rounded-xl transition-all duration-150 active:scale-90 disabled:opacity-50 shrink-0" disabled={!isConnected}><Mic size={24} /></button>
                  )
              )}
              <div className={clsx("relative flex-1 rounded-2xl flex items-center min-h-[50px] bg-slate-100 dark:bg-slate-800")}>
                <input
                  type="text"
                  value={inputText}
                  onChange={handleTyping}
                  onFocus={() => setShowSafetyWarning(false)}
                  placeholder={isConnected ? (settings.vanishMode ? "Vanish message..." : "Type a message...") : "Disconnected"}
                  className="w-full bg-transparent border-0 px-4 py-3 placeholder:text-slate-400 focus:outline-none text-slate-900 dark:text-white"
                  autoComplete="off"
                  disabled={!isConnected}
                />
              </div>
              {inputText.trim() && (
                <button type="submit" className="p-3 bg-brand-600 hover:bg-brand-700 text-white rounded-xl shadow-lg shadow-brand-500/20 transition-all duration-150 active:scale-90 shrink-0"><Send size={24} /></button>
              )}
            </form>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Suspense fallback={<div className="fixed inset-0 flex items-center justify-center bg-slate-50 dark:bg-[#05050A]"><Loader /></div>}>
      <div className={clsx("h-[100dvh] flex flex-col font-sans transition-colors duration-200 overflow-hidden", theme === 'dark' ? "bg-[#05050A]" : "bg-slate-50")}>
        
        {(status !== ChatMode.IDLE || userProfile) && (
          <Header 
            onlineCount={onlineUsers.length} 
            mode={status}
            theme={theme}
            toggleTheme={toggleTheme}
            onDisconnect={disconnect}
            partnerProfile={partnerProfile}
            onOpenSettings={() => setShowSettingsModal(true)}
            onEditProfile={() => setShowEditProfileModal(true)}
            onAddFriend={partnerPeerId ? sendFriendRequest : undefined}
            isFriend={isCurrentPartnerFriend}
            isVanishMode={settings.vanishMode}
          />
        )}

        {renderMainContent()}

        {showJoinModal && (
          <Suspense fallback={null}>
            <JoinModal 
              onClose={() => setShowJoinModal(false)} 
              onJoin={handleJoin} 
            />
          </Suspense>
        )}

        {showEditProfileModal && userProfile && (
           <Suspense fallback={null}>
             <JoinModal 
               onClose={() => setShowEditProfileModal(false)} 
               onJoin={handleUpdateProfile}
               initialProfile={userProfile}
               isEditing
             />
           </Suspense>
        )}

        {showSettingsModal && (
           <Suspense fallback={null}>
             <SettingsModal 
               isOpen={showSettingsModal} 
               onClose={() => setShowSettingsModal(false)}
               settings={settings}
               onUpdateSettings={handleUpdateSettings}
             />
           </Suspense>
        )}
        
        {editingMessage && (
           <Suspense fallback={null}>
             <EditMessageModal
               isOpen={!!editingMessage}
               onClose={() => setEditingMessage(null)}
               initialText={editingMessage.text}
               onSave={saveEditedMessage}
             />
           </Suspense>
        )}
        
        {userProfile && (
           <Suspense fallback={null}>
              <SocialHub 
                 onlineUsers={onlineUsers}
                 onCallPeer={handleDirectCall}
                 globalMessages={globalMessages}
                 sendGlobalMessage={sendGlobalMessage}
                 myProfile={userProfile}
                 myPeerId={myPeerId}
                 privateMessages={[]} 
                 sendPrivateMessage={() => {}}
                 sendDirectMessage={sendDirectMessage}
                 sendDirectImage={sendDirectImage}
                 sendDirectAudio={sendDirectAudio}
                 sendDirectTyping={sendDirectTyping}
                 sendDirectFriendRequest={sendDirectFriendRequest}
                 sendDirectReaction={sendDirectReaction}
                 sendReaction={sendReaction}
                 currentPartner={partnerProfile}
                 chatStatus={status}
                 error={error}
                 onEditMessage={initiateEdit}
                 sessionType={sessionType}
                 incomingReaction={incomingReaction}
                 incomingDirectMessage={incomingDirectMessage}
                 incomingDirectStatus={incomingDirectStatus}
                 friends={friends}
                 friendRequests={friendRequests}
                 removeFriend={removeFriend}
                 acceptFriendRequest={acceptFriendRequest}
                 rejectFriendRequest={rejectFriendRequest}
                 isPeerConnected={isPeerConnected}
              />
           </Suspense>
        )}
        
        {(notification || localNotification) && (
           <div className="fixed top-20 left-1/2 -translate-x-1/2 z-[150] animate-in slide-in-from-top-2 fade-in duration-300 pointer-events-none w-full max-w-sm px-4 flex justify-center">
              <div className="bg-slate-800/90 dark:bg-white/10 text-white backdrop-blur-md px-4 py-2 rounded-full shadow-xl border border-white/10 text-sm font-medium flex items-center gap-2 truncate max-w-full">
                 <Bell size={16} className="text-brand-400 shrink-0" /> <span className="truncate">{localNotification || notification}</span>
              </div>
           </div>
        )}
        
        {friendNotification && (
            <div className="fixed top-28 left-1/2 -translate-x-1/2 z-[150] animate-in slide-in-from-top-2 fade-in duration-300 pointer-events-none w-full max-w-sm px-4 flex justify-center">
              <div className="bg-emerald-500/90 text-white backdrop-blur-md px-4 py-2 rounded-full shadow-xl border border-white/10 text-sm font-medium flex items-center gap-2 truncate max-w-full">
                 <span className="truncate">{friendNotification}</span>
              </div>
           </div>
        )}

        <ImageConfirmationModal 
          isOpen={!!pendingImage}
          imageSrc={pendingImage}
          onClose={() => setPendingImage(null)}
          onConfirm={handleConfirmImage}
        />

        {previewImage && (
           <ImageViewer src={previewImage} onClose={() => setPreviewImage(null)} />
        )}

      </div>
    </Suspense>
  );
}