/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { Download, Search, Loader2, Video, Music, AlertCircle, Copy, Check, Zap, Shield, Sparkles, ArrowUpCircle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { apiUrl, nativeEventSource } from './apiClient';

interface VideoInfo {
  title: string;
  thumbnail: string;
  duration: number;
  channel: string;
}

export default function App() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [videoInfo, setVideoInfo] = useState<VideoInfo | null>(null);
  const [copied, setCopied] = useState(false);
  const [updateRequired, setUpdateRequired] = useState(false);
  const [updateUrl, setUpdateUrl] = useState('');
  const [toast, setToast] = useState<{ title: string; message: string; type: 'success' | 'info' } | null>(null);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => {
        setToast(null);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const [isAppLoading, setIsAppLoading] = useState(true);

  useEffect(() => {
    const checkVersion = async () => {
      const urlParams = new URLSearchParams(window.location.search);
      const platform = urlParams.get('platform');
      const version = urlParams.get('version');
      
      if (platform === 'android') {
        try {
          const res = await fetch(apiUrl(`/api/version-check?platform=android&version=${version || 1}`));
          if (res.ok) {
            const data = await res.json();
            if (data.updateRequired) {
              setUpdateRequired(true);
              setUpdateUrl(data.updateUrl);
            }
          }
        } catch (err) {
          console.error("Failed to check version:", err);
        }
      }
      
      setTimeout(() => {
        setIsAppLoading(false);
      }, 4000);
    };
    checkVersion();
  }, []);

  const handleCopyUrl = () => {
    if (!url) return;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const fetchInfo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;
    
    setLoading(true);
    setError('');
    setVideoInfo(null);
    
    try {
      const res = await fetch(apiUrl('/api/video-info'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url }),
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Failed to fetch video information');
      }
      
      setVideoInfo(data);
    } catch (err: any) {
      setError(err.message || 'An error occurred fetching the video.');
    } finally {
      setLoading(false);
    }
  };

  const [downloadingType, setDownloadingType] = useState<'video' | 'audio' | null>(null);
  const [downloadProgress, setDownloadProgress] = useState<number>(0);
  const [downloadText, setDownloadText] = useState<string>('');

  const activeEventSourceRef = useRef<EventSource | null>(null);
  const stateRef = useRef({ videoInfo, error, downloadingType });

  // Keep stateRef up to date to prevent stale closures
  useEffect(() => {
    stateRef.current = { videoInfo, error, downloadingType };
  }, [videoInfo, error, downloadingType]);

  const cancelActiveDownload = () => {
    if (activeEventSourceRef.current) {
      activeEventSourceRef.current.close();
      activeEventSourceRef.current = null;
    }
    setDownloadingType(null);
    setDownloadProgress(0);
    setDownloadText('');
  };

  useEffect(() => {
    (window as any).onAndroidBack = () => {
      const { videoInfo, error, downloadingType } = stateRef.current;
      
      if (downloadingType) {
        cancelActiveDownload();
        return true; // handled
      }
      if (error) {
        setError('');
        return true; // handled
      }
      if (videoInfo) {
        setVideoInfo(null);
        setUrl('');
        return true; // handled
      }
      
      // Native exit fallback
      if ((window as any).AndroidInterface && (window as any).AndroidInterface.exitApp) {
        (window as any).AndroidInterface.exitApp();
        return true;
      }
      
      return false; // let Android WebView handle exit
    };

    return () => {
      delete (window as any).onAndroidBack;
    };
  }, []);

  const checkAndRequestAndroidPermissions = async (): Promise<boolean> => {
    const androidBridge = (window as any).AndroidInterface;
    if (!androidBridge) return true; // Standard browser, proceed

    try {
      if (androidBridge.hasStoragePermission) {
        const hasPermission = androidBridge.hasStoragePermission();
        if (hasPermission === true || hasPermission === "true") {
          return true;
        }
      }

      if (androidBridge.requestStoragePermission) {
        const result = await androidBridge.requestStoragePermission();
        return result === true || result === "true";
      }
      
      return true;
    } catch (err) {
      console.error("Android permission bridge error:", err);
      return true;
    }
  };

  const handleDownload = async (type: 'video' | 'audio') => {
    if (!url) return;

    // Request notification permission if not yet granted
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission();
    }

    // Check Android Storage Permission before starting
    const permissionGranted = await checkAndRequestAndroidPermissions();
    if (!permissionGranted) {
      setError("Storage permission is required to save downloads on this device.");
      return;
    }

    setDownloadingType(type);
    setError('');
    setDownloadProgress(0);
    setDownloadText('Connecting...');

    const titleParam = videoInfo ? `&title=${encodeURIComponent(videoInfo.title)}` : '';
    const thumbParam = videoInfo ? `&thumbnail=${encodeURIComponent(videoInfo.thumbnail)}` : '';
    const eventSource = nativeEventSource(`/api/prepare-stream?url=${encodeURIComponent(url)}&type=${type}${titleParam}${thumbParam}`);
    activeEventSourceRef.current = eventSource;

    eventSource.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.error) {
          setError(data.error);
          setDownloadingType(null);
          eventSource.close();
          activeEventSourceRef.current = null;
        } else if (data.downloadUrl) {
          setDownloadProgress(100);
          setDownloadText('Saving file...');
          eventSource.close();
          activeEventSourceRef.current = null;

          // Build absolute URL (required inside Capacitor WebView)
          const absoluteUrl = apiUrl(data.downloadUrl);

          try {
            // Fetch file as blob — no page navigation, no redirect
            const fileResp = await fetch(absoluteUrl);
            if (!fileResp.ok) throw new Error(`Server error: ${fileResp.status}`);
            const blob = await fileResp.blob();

            // Derive a clean filename
            const ext = type === 'audio' ? 'mp3' : 'mp4';
            const safeName = (videoInfo?.title || 'video')
              .replace(/[^\w\s-]/g, '')
              .trim()
              .substring(0, 80) || 'video';
            const filename = `${safeName}.${ext}`;

            // Create a temporary object URL and click a hidden <a download>
            const blobUrl = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = blobUrl;
            anchor.download = filename;
            anchor.style.display = 'none';
            document.body.appendChild(anchor);
            anchor.click();
            document.body.removeChild(anchor);
            // Revoke after a short delay to let the browser start the download
            setTimeout(() => URL.revokeObjectURL(blobUrl), 5000);
          } catch (dlErr: any) {
            setError('Download failed: ' + (dlErr.message || 'Unknown error'));
            setDownloadingType(null);
            return;
          }

          // Trigger in-app toast
          setToast({
            title: 'Download Complete!',
            message: `"${videoInfo?.title || 'Your file'}" is now saving to your device.`,
            type: 'success'
          });

          // Trigger native system notification
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            try {
              new Notification("All Video Downloader", {
                body: `"${videoInfo?.title || 'Your file'}" has finished downloading!`,
                icon: videoInfo?.thumbnail || undefined
              });
            } catch (err) {
              console.warn("Could not trigger system notification:", err);
            }
          }

          setTimeout(() => {
            setDownloadingType(null);
            setDownloadText('');
          }, 2000);
        } else {
          setDownloadProgress(data.progress || 0);
          if (data.text) setDownloadText(data.text);
        }
      } catch (e) {
        console.error("Error parsing SSE:", e);
      }
    };

    eventSource.onerror = () => {
      setError('Connection lost while preparing download.');
      setDownloadingType(null);
      eventSource.close();
      activeEventSourceRef.current = null;
    };
  };

  const formatDuration = (seconds: number) => {
    if (!seconds) return 'Unknown';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  if (isAppLoading) {
    return (
      <div className="min-h-screen bg-slate-950 text-white font-sans relative overflow-hidden flex flex-col items-center justify-center p-6 selection:bg-indigo-500/30">
        {/* Decorative Background Elements */}
        <div className="absolute top-[-100px] left-[20%] w-[500px] h-[500px] bg-indigo-600/20 rounded-full blur-[120px] pointer-events-none mix-blend-screen"></div>
        <div className="absolute bottom-[-100px] right-[20%] w-[500px] h-[500px] bg-purple-600/10 rounded-full blur-[150px] pointer-events-none mix-blend-screen"></div>
        
        {/* Radar pulsing ripple */}
        <div className="absolute flex items-center justify-center w-80 h-80 pointer-events-none">
          <motion.div 
            initial={{ scale: 0.8, opacity: 0.5 }}
            animate={{ scale: 1.5, opacity: 0 }}
            transition={{ repeat: Infinity, duration: 2.5, ease: "easeOut" }}
            className="absolute w-48 h-48 border border-indigo-500/20 rounded-full"
          />
          <motion.div 
            initial={{ scale: 0.8, opacity: 0.3 }}
            animate={{ scale: 2.0, opacity: 0 }}
            transition={{ repeat: Infinity, duration: 2.5, delay: 0.8, ease: "easeOut" }}
            className="absolute w-48 h-48 border border-purple-500/10 rounded-full"
          />
        </div>

        {/* Logo/Icon Container */}
        <motion.div 
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5 }}
          className="relative z-10 w-24 h-24 bg-gradient-to-tr from-indigo-600 to-purple-600 rounded-3xl flex items-center justify-center mb-8 shadow-[0_0_50px_rgba(99,102,241,0.3)]"
        >
          {/* Animated loading border ring */}
          <div className="absolute inset-[-4px] rounded-[2rem] border-2 border-transparent border-t-indigo-300 border-r-purple-300 animate-spin pointer-events-none" />
          <Download className="w-11 h-11 text-white animate-bounce" />
        </motion.div>

        {/* Text Loader */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2, duration: 0.5 }}
          className="text-center relative z-10"
        >
          <h1 className="text-3xl md:text-4xl font-display font-extrabold mb-3 tracking-tight bg-gradient-to-br from-white via-indigo-100 to-indigo-400 text-transparent bg-clip-text">
            All Video Downloader
          </h1>
          <p className="text-slate-500 text-sm font-medium tracking-wide flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
            Initializing secure download workspace...
          </p>
        </motion.div>
      </div>
    );
  }

  if (updateRequired) {
    return (
      <div className="min-h-screen bg-slate-950 text-white font-sans relative overflow-hidden flex items-center justify-center p-6 selection:bg-rose-500/30">
        {/* Decorative Background Elements */}
        <div className="absolute top-[-10%] left-[20%] w-[500px] h-[500px] bg-rose-600/20 rounded-full blur-[120px] pointer-events-none mix-blend-screen"></div>
        <div className="absolute bottom-[-10%] right-[20%] w-[500px] h-[500px] bg-indigo-600/10 rounded-full blur-[150px] pointer-events-none mix-blend-screen"></div>
        <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.01)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.01)_1px,transparent_1px)] bg-[size:4rem_4rem] pointer-events-none"></div>

        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="bg-slate-900/60 backdrop-blur-2xl border border-white/10 p-8 sm:p-12 rounded-[2.5rem] shadow-2xl text-center max-w-md w-full relative z-10"
        >
          <div className="w-20 h-20 bg-rose-500/10 border border-rose-500/20 rounded-3xl flex items-center justify-center mx-auto mb-8 text-rose-400 shadow-[0_0_30px_rgba(244,63,94,0.15)] relative">
            <motion.div 
              animate={{ scale: [1, 1.1, 1] }} 
              transition={{ repeat: Infinity, duration: 2 }}
            >
              <AlertCircle className="w-10 h-10" />
            </motion.div>
          </div>

          <h1 className="text-3xl font-extrabold mb-4 bg-gradient-to-br from-white via-slate-100 to-rose-200 text-transparent bg-clip-text">
            Update Required
          </h1>
          
          <p className="text-slate-400 text-base leading-relaxed mb-8">
            A critical new version of the app is available. To continue downloading your favorite videos, please update to the latest release now.
          </p>

          <a
            href={updateUrl || 'https://codetutorium.com'}
            className="w-full py-4 bg-gradient-to-r from-rose-500 to-indigo-600 hover:from-rose-400 hover:to-indigo-500 text-white font-bold rounded-2xl transition-all shadow-[0_0_35px_rgba(244,63,94,0.25)] flex items-center justify-center gap-2 text-base active:scale-[0.98]"
          >
            <ArrowUpCircle className="w-5 h-5" />
            Update App Now
          </a>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white font-sans relative overflow-x-hidden flex flex-col selection:bg-indigo-500/30">
      {/* Decorative Background Elements */}
      <div className="absolute top-[-150px] left-[10%] w-[500px] h-[500px] bg-indigo-600/20 rounded-full blur-[120px] pointer-events-none mix-blend-screen"></div>
      <div className="absolute bottom-[-100px] right-[10%] w-[600px] h-[600px] bg-purple-600/10 rounded-full blur-[150px] pointer-events-none mix-blend-screen"></div>

      {/* Grid Pattern */}
      <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 pointer-events-none mix-blend-overlay"></div>
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:4rem_4rem] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)] pointer-events-none"></div>

      <div className="relative z-10 flex-grow flex flex-col px-6 py-12 w-full overflow-y-auto max-w-5xl mx-auto">
        
        {/* Header */}
        <div className="text-center mb-14 mt-8">
          <motion.div
            initial={{ opacity: 0, scale: 0.8, rotate: -10 }}
            animate={{ opacity: 1, scale: 1, rotate: 0 }}
            transition={{ type: "spring", stiffness: 200, damping: 20 }}
            className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-tr from-indigo-500 to-purple-500 rounded-2xl mb-8 shadow-[0_0_40px_rgba(99,102,241,0.4)]"
          >
            <Download className="w-8 h-8 text-white" />
          </motion.div>
          <motion.h1 
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1, duration: 0.5 }}
            className="text-5xl md:text-7xl font-display font-extrabold mb-6 tracking-tight bg-gradient-to-br from-white via-indigo-100 to-indigo-400 text-transparent bg-clip-text pb-2"
          >
            All Video Downloader
          </motion.h1>
          <motion.p 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.2, duration: 0.5 }}
            className="text-slate-400 text-lg md:text-xl max-w-2xl mx-auto leading-relaxed"
          >
            Instantly download high-quality video and audio from your favorite platforms. Fast, secure, and completely free.
          </motion.p>
        </div>

        {/* Input Form */}
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.3, duration: 0.5 }}
          className="mb-14 w-full max-w-3xl mx-auto"
        >
          <form onSubmit={fetchInfo} className="bg-slate-900/50 backdrop-blur-xl border border-white/10 p-3 sm:p-2 rounded-3xl sm:rounded-[2rem] shadow-2xl flex flex-col sm:flex-row items-stretch sm:items-center relative focus-within:ring-2 focus-within:ring-indigo-500/50 focus-within:border-indigo-500/50 transition-all duration-300 gap-2 sm:gap-0">
            <div className="hidden sm:flex px-6-text-white/40 pl-6 pr-4">
              <Search className="h-6 w-6 text-slate-400" />
            </div>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Paste video URL here (YouTube, Twitter, etc.)..."
              required
              className="flex-grow bg-transparent border-none outline-none text-base sm:text-lg md:text-xl placeholder:text-slate-500 text-white font-medium min-w-0 py-3 sm:py-4 px-4 sm:px-0"
            />
            <button
              type="submit"
              disabled={loading || !url}
              className="bg-indigo-500 hover:bg-indigo-400 disabled:bg-indigo-500/50 text-white px-6 sm:px-10 py-3.5 sm:py-4 rounded-2xl sm:rounded-full font-bold transition-all shadow-[0_0_20px_rgba(99,102,241,0.3)] hover:shadow-[0_0_30px_rgba(99,102,241,0.5)] flex items-center justify-center gap-2 shrink-0 sm:ml-2"
            >
              {loading ? <Loader2 className="w-6 h-6 animate-spin" /> : 'Fetch'}
            </button>
          </form>
            
          <div className="mt-8 flex flex-wrap gap-4 text-sm justify-center items-center">
            <span className="text-slate-500 font-semibold uppercase tracking-[0.15em] text-xs">Example:</span>
            <button
              type="button"
              onClick={() => setUrl('https://www.youtube.com/watch?v=F3_mPteSgMw')}
              className="px-5 py-2 bg-slate-800/50 hover:bg-slate-700/50 border border-white/5 hover:border-white/10 rounded-full text-indigo-300 font-medium transition-all backdrop-blur-md"
            >
              Top Flight
            </button>
          </div>
        </motion.div>

        {/* Error State */}
        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, height: 0, y: -10 }}
              animate={{ opacity: 1, height: 'auto', y: 0 }}
              exit={{ opacity: 0, height: 0 }}
              className="mb-10 w-full max-w-3xl mx-auto"
            >
              <div className="bg-red-500/10 backdrop-blur-md border border-red-500/20 rounded-2xl p-4 flex items-center gap-4 text-red-400 font-medium">
                <AlertCircle className="w-6 h-6 shrink-0" />
                <p>{error}</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Features / Empty State */}
        <AnimatePresence>
          {!videoInfo && !loading && !error && (
            <motion.div 
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ delay: 0.4 }}
              className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-4xl mx-auto w-full mt-4"
            >
               <div className="bg-slate-900/40 backdrop-blur-sm border border-white/5 rounded-3xl p-8 text-center flex flex-col items-center">
                 <div className="w-12 h-12 bg-blue-500/10 rounded-2xl flex items-center justify-center mb-6 text-blue-400">
                    <Zap className="w-6 h-6" />
                 </div>
                 <h3 className="text-white font-display font-bold text-xl mb-2">Lightning Fast</h3>
                 <p className="text-slate-400 leading-relaxed text-sm">Download your media in seconds using our highly optimized delivery network.</p>
               </div>
               <div className="bg-slate-900/40 backdrop-blur-sm border border-white/5 rounded-3xl p-8 text-center flex flex-col items-center">
                 <div className="w-12 h-12 bg-purple-500/10 rounded-2xl flex items-center justify-center mb-6 text-purple-400">
                    <Sparkles className="w-6 h-6" />
                 </div>
                 <h3 className="text-white font-display font-bold text-xl mb-2">High Quality</h3>
                 <p className="text-slate-400 leading-relaxed text-sm">Extract maximum resolution videos up to 4K or crisp audio streams instantly.</p>
               </div>
               <div className="bg-slate-900/40 backdrop-blur-sm border border-white/5 rounded-3xl p-8 text-center flex flex-col items-center">
                 <div className="w-12 h-12 bg-emerald-500/10 rounded-2xl flex items-center justify-center mb-6 text-emerald-400">
                    <Shield className="w-6 h-6" />
                 </div>
                 <h3 className="text-white font-display font-bold text-xl mb-2">Private & Secure</h3>
                 <p className="text-slate-400 leading-relaxed text-sm">No tracking, no watermarks, and completely secure downloads every time.</p>
               </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Results Info */}
        <AnimatePresence mode="wait">
          {loading ? (
            <motion.div
              key="skeleton"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              className="bg-slate-900/60 backdrop-blur-xl border border-white/10 rounded-[2rem] overflow-hidden shadow-2xl mb-10 w-full max-w-4xl mx-auto"
            >
              <div className="flex flex-col md:flex-row">
                <div className="w-full md:w-1/2 lg:w-5/12 bg-black/40 relative aspect-video flex-shrink-0 animate-pulse">
                </div>
                
                <div className="p-8 md:p-10 flex flex-col justify-center w-full md:w-1/2 lg:w-7/12 gap-3">
                  <div className="h-8 bg-white/10 rounded-lg animate-pulse w-3/4"></div>
                  <div className="h-8 bg-white/10 rounded-lg animate-pulse w-1/2 mb-4"></div>
                  <div className="h-4 bg-white/10 rounded-lg animate-pulse w-1/3 mb-8"></div>
                  
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="h-14 bg-indigo-500/20 rounded-2xl animate-pulse"></div>
                    <div className="h-14 bg-white/5 rounded-2xl animate-pulse"></div>
                  </div>
                </div>
              </div>
            </motion.div>
          ) : videoInfo && !error ? (
            <motion.div
              key="result"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 20 }}
              className="bg-slate-900/60 backdrop-blur-xl border border-white/10 rounded-[2rem] overflow-hidden shadow-2xl mb-10 max-w-4xl mx-auto w-full"
            >
              <div className="flex flex-col md:flex-row">
                <div className="w-full md:w-1/2 lg:w-5/12 bg-black/60 relative p-4 flex items-center justify-center">
                  <div className="relative w-full h-full rounded-xl overflow-hidden aspect-video shadow-lg">
                    {videoInfo.thumbnail ? (
                      <img 
                        src={videoInfo.thumbnail} 
                        alt={videoInfo.title}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-white/50 bg-slate-800">
                        No Thumbnail
                      </div>
                    )}
                    {videoInfo.duration > 0 && (
                       <div className="absolute bottom-3 right-3 px-2 py-1 bg-black/80 backdrop-blur-md text-xs font-mono rounded-md text-white font-medium border border-white/10 shadow-sm">
                         {formatDuration(videoInfo.duration)}
                       </div>
                    )}
                  </div>
                </div>
                
                <div className="p-8 md:p-10 flex flex-col justify-center w-full md:w-1/2 lg:w-7/12">
                  <div className="flex items-start justify-between gap-4 mb-3">
                    <h3 className="text-2xl md:text-3xl font-display font-bold line-clamp-2 leading-tight text-white">
                      {videoInfo.title}
                    </h3>
                    <button
                      onClick={handleCopyUrl}
                      className="shrink-0 p-2.5 text-slate-400 hover:text-white bg-white/5 hover:bg-white/10 rounded-xl transition-all border border-white/5 hover:border-white/20 active:scale-95"
                      title="Copy video URL"
                    >
                        {copied ? <Check className="w-5 h-5 text-emerald-400" /> : <Copy className="w-5 h-5" />}
                    </button>
                  </div>
                  <p className="text-slate-400 mb-8 border-b border-white/5 pb-6 line-clamp-1 font-medium">
                    {videoInfo.channel}
                  </p>
                  
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {downloadingType ? (
                      <div className="col-span-1 sm:col-span-2 bg-indigo-500/10 border border-indigo-500/30 rounded-2xl p-6">
                        <div className="flex items-center justify-between mb-3">
                          <span className="text-indigo-300 font-medium">{downloadText}</span>
                          <span className="text-white font-bold">{downloadProgress}%</span>
                        </div>
                        <div className="w-full bg-slate-900/50 rounded-full h-3 overflow-hidden">
                          <motion.div 
                            className="bg-gradient-to-r from-indigo-500 to-purple-500 h-full rounded-full"
                            initial={{ width: 0 }}
                            animate={{ width: `${downloadProgress}%` }}
                            transition={{ ease: "easeOut", duration: 0.3 }}
                          />
                        </div>
                      </div>
                    ) : (
                      <>
                        <button 
                          onClick={() => handleDownload('video')}
                          className="flex items-center justify-center gap-3 w-full py-4 bg-indigo-500 hover:bg-indigo-400 text-white font-bold rounded-2xl transition-colors shadow-lg shadow-indigo-500/30"
                        >
                          <Video className="w-5 h-5" />
                          Download Video
                        </button>
                        <button 
                          onClick={() => handleDownload('audio')}
                          className="flex items-center justify-center gap-3 w-full py-4 bg-white/10 hover:bg-white/20 text-white font-bold rounded-2xl transition-colors backdrop-blur-lg border border-white/10"
                        >
                          <Music className="w-5 h-5" />
                          Download Audio
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>

        {/* Footer */}
        <motion.footer 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5, duration: 0.5 }}
          className="mt-auto pt-16 pb-4 text-center border-t border-white/5 text-slate-500 text-sm font-medium"
        >
          <p className="flex flex-col sm:flex-row justify-center items-center gap-2 sm:gap-1.5">
            <span>&copy; {new Date().getFullYear()} All Video Downloader. All rights reserved.</span>
            <span className="hidden sm:inline text-slate-700">&bull;</span>
            <span>
              Powered by{' '}
              <a 
                href="https://codetutorium.com" 
                target="_blank" 
                rel="noopener noreferrer" 
                className="text-indigo-400 hover:text-indigo-300 transition-colors underline underline-offset-4 decoration-indigo-500/30 hover:decoration-indigo-400"
              >
                codetutorium.com
              </a>
            </span>
          </p>
        </motion.footer>

      </div>

      {/* Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.9 }}
            className="fixed bottom-6 right-6 z-50 max-w-md w-full sm:w-[28rem] bg-slate-900/80 backdrop-blur-2xl border border-white/10 p-5 rounded-2xl shadow-2xl flex items-start gap-4 select-none"
          >
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 flex items-center justify-center shrink-0 shadow-[0_0_15px_rgba(16,185,129,0.1)]">
              <Check className="w-5 h-5 animate-pulse" />
            </div>
            
            <div className="flex-grow min-w-0 pr-4">
              <h4 className="text-white font-bold text-sm mb-1 leading-none">{toast.title}</h4>
              <p className="text-slate-400 text-xs leading-normal line-clamp-2">{toast.message}</p>
            </div>

            <button
              onClick={() => setToast(null)}
              className="p-1 hover:bg-white/5 rounded-lg text-slate-500 hover:text-white transition-colors shrink-0"
              title="Close notification"
              aria-label="Close notification"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
