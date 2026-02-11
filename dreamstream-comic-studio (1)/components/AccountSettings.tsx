import React, { useState, useEffect } from 'react';
import { User } from '@supabase/supabase-js';
import { UserProfile } from '../types';
import { supabase } from '../services/supabase';
import {
    getUserProfile,
    updateUserProfile,
    updateUserAvatar,
    generateCoupon,
    redeemCoupon,
    loadCoupons,
    saveImage,
    savePublicContactMessage
} from '../services/db';
import { getFluxKeyInfo } from '../services/appSettings';
import { Button } from './Button';
import { SettingsModal } from './SettingsModal';
import { FluxKeyInput } from './FluxKeyInput';
import { KeyManager } from './KeyManager';
import { encryptKey } from '../services/crypto';
import { User as UserIcon, Settings, CreditCard, Shield, Mail, Upload, Camera, Save, LogOut, Eye, EyeOff, Copy, CheckCircle2, AlertTriangle, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { createCheckoutSession } from '../services/billing';
import { useSearchParams } from 'react-router-dom';

interface AccountSettingsProps {
    onClose: () => void;
    initialTab?: 'profile' | 'settings' | 'billing' | 'legal' | 'contact' | 'admin';
}

const ContactSection = () => {
    const { user } = useAuth();
    const [msg, setMsg] = useState('');
    const [contactEmail, setContactEmail] = useState(user?.email || '');
    const [sent, setSent] = useState(false);

    const send = async (e: React.FormEvent) => {
        e.preventDefault();
        await savePublicContactMessage(contactEmail, msg);
        setSent(true);
    };

    if (sent) return (
        <div className="flex flex-col items-center justify-center py-20 text-center animate-fade-in">
            <div className="w-20 h-20 bg-green-100 text-green-600 rounded-full flex items-center justify-center mb-4 border-4 border-black">
                <Mail size={40} />
            </div>
            <h3 className="font-display text-2xl">Message Sent!</h3>
            <p className="font-comic text-slate-600 mt-2">A representative will be in touch shortly.</p>
            <button onClick={() => setSent(false)} className="mt-8 text-sm font-bold underline">Send another</button>
        </div>
    );

    return (
        <div className="max-w-xl animate-fade-in">
            <h3 className="font-display text-2xl mb-2">Contact Support</h3>
            <p className="text-slate-500 mb-6 font-comic">Found a bug? Have a feature request? Let us know.</p>
            <form onSubmit={send} className="space-y-4">
                <div>
                    <label className="font-bold text-xs uppercase">Your Email</label>
                    <input type="email" required value={contactEmail} onChange={e => setContactEmail(e.target.value)}
                        className="w-full mt-1 border-2 border-black rounded-lg px-4 py-2 font-mono" />
                </div>
                <div>
                    <label className="font-bold text-xs uppercase">Message (Max 1000 chars)</label>
                    <textarea required maxLength={1000} rows={6} value={msg} onChange={e => setMsg(e.target.value)}
                        className="w-full mt-1 border-2 border-black rounded-lg px-4 py-2 font-mono" />
                    <div className="text-right text-xs text-slate-400 mt-1">{msg.length}/1000</div>
                </div>
                <Button type="submit" icon={<Mail size={16} />}>Send Message</Button>
            </form>
        </div>
    );
};
export const AccountSettings: React.FC<AccountSettingsProps> = ({ onClose, initialTab = 'profile' }) => {
    const { user, signOut } = useAuth();
    const [activeTab, setActiveTab] = useState<'profile' | 'settings' | 'billing' | 'legal' | 'contact' | 'admin'>(initialTab);
    const [searchParams] = useSearchParams();
    const [upgradeLoading, setUpgradeLoading] = useState(false);
    const [previewAvatar, setPreviewAvatar] = useState<string | null>(null);

    useEffect(() => {
        if (searchParams.get('success') === 'true') {
            alert("Upgrade Successful! You are now a Pro member.");
        }
        if (searchParams.get('canceled') === 'true') {
            console.log("Upgrade canceled");
        }
    }, [searchParams]);
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [loading, setLoading] = useState(true);
    const [couponCode, setCouponCode] = useState('');
    const [redeemMsg, setRedeemMsg] = useState<{ type: 'success' | 'error', text: string } | null>(null);
    const [adminCoupons, setAdminCoupons] = useState<any[]>([]);
    const [isAdmin, setIsAdmin] = useState(false);

    useEffect(() => {
        if (user) {
            setIsAdmin(user.email === 'admin@test.com');
            // ... existing profile load ...
        }
    }, [user]);

    const handleGenerateCoupon = async () => {
        const code = await generateCoupon();
        if (code) {
            setAdminCoupons(prev => [{ code, is_redeemed: false, created_at: new Date().toISOString() }, ...prev]);
        }
    };

    const handleRedeem = async () => {
        if (!couponCode) return;
        const res = await redeemCoupon(couponCode);
        setRedeemMsg({ type: res.success ? 'success' : 'error', text: res.message });
        if (res.success) {
            // Refresh profile/limits if needed, or just tell user to refresh
            setTimeout(() => window.location.reload(), 1500);
        }
    };

    const loadAdminData = async () => {
        if (user?.email === 'admin@test.com') {
            const data = await loadCoupons();
            setAdminCoupons(data);
        }
    };

    useEffect(() => {
        if (activeTab === 'admin') loadAdminData();
    }, [activeTab]);

    // Profile State
    const [username, setUsername] = useState('');
    const [avatarUrl, setAvatarUrl] = useState('');
    const [isSaving, setIsSaving] = useState(false);

    // Load Profile
    useEffect(() => {
        if (user) {
            getUserProfile(user.id).then(p => {
                if (p) {
                    setProfile(p);
                    setUsername(p.username || '');
                    setAvatarUrl(p.avatar_url || '');
                }
                setLoading(false);
            });
        }
    }, [user]);

    const handleSaveProfile = async () => {
        if (!user) return;
        setIsSaving(true);
        try {
            await updateUserProfile(user.id, { username, avatar_url: avatarUrl });
            alert("Profile updated!");
        } catch (e) {
            alert("Failed to update profile.");
        } finally {
            setIsSaving(false);
        }
    };

    const handleAvatarUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files || e.target.files.length === 0) return;
        const file = e.target.files[0];
        const reader = new FileReader();
        reader.onloadend = async () => {
            const base64 = reader.result as string;
            // Upload to storage
            // We use 'saveImage' which returns 'user_id/uuid'
            // But we want a public URL for avatar probably? 
            // saveImage does upload to Supabase Storage.
            try {
                // Resize? Ideally yes.
                const path = await saveImage(base64);
                // Get Public URL
                const { data } = supabase.storage.from('comic-assets').getPublicUrl(path);
                setAvatarUrl(data.publicUrl);
            } catch (err) {
                alert("Upload failed");
            }
        };
        reader.readAsDataURL(file);
    };

    // Tabs Content
    const renderProfile = () => (
        <div className="space-y-8 animate-fade-in max-w-2xl">
            <div className="flex items-start gap-8">
                <div className="relative group">
                    <div
                        className="w-32 h-32 rounded-full border-4 border-black overflow-hidden bg-slate-200 cursor-pointer"
                        onClick={() => avatarUrl && setPreviewAvatar(avatarUrl)}
                    >
                        {avatarUrl ? (
                            <img src={avatarUrl} alt="Avatar" className="w-full h-full object-cover" />
                        ) : (
                            <div className="w-full h-full flex items-center justify-center text-slate-400">
                                <UserIcon size={48} />
                            </div>
                        )}
                    </div>
                    <label className="absolute bottom-0 right-0 bg-brand-yellow border-2 border-black p-2 rounded-full cursor-pointer hover:bg-yellow-300 shadow-comic transition-transform hover:scale-105 z-10">
                        <Upload size={16} />
                        <input type="file" className="hidden" accept="image/*" onChange={handleAvatarUpload} />
                    </label>
                </div>
                <div className="flex-1 space-y-4">
                    <div>
                        <label className="font-display text-lg">Username</label>
                        <input
                            type="text"
                            value={username}
                            onChange={e => setUsername(e.target.value)}
                            className="w-full mt-1 border-2 border-black rounded-xl px-4 py-2 font-mono"
                        />
                    </div>
                    <div>
                        <label className="font-display text-lg">Email</label>
                        <input
                            type="text"
                            value={user?.email}
                            disabled
                            className="w-full mt-1 border-2 border-black rounded-xl px-4 py-2 font-mono bg-slate-100 text-slate-500 cursor-not-allowed"
                        />
                    </div>
                </div>
            </div>

            <div className="pt-8 border-t-2 border-slate-200">
                <Button onClick={handleSaveProfile} disabled={isSaving} icon={<Save size={18} />}>
                    {isSaving ? "Saving..." : "Save Changes"}
                </Button>
            </div>
        </div>
    );

    const renderBilling = () => (
        <div className="space-y-6 animate-fade-in">
            <div className="grid md:grid-cols-2 gap-6">
                {/* Free Card */}
                <div className="border-4 border-slate-200 bg-slate-50 p-6 rounded-2xl opacity-70">
                    <h3 className="font-display text-2xl text-slate-500">Free Tier</h3>
                    <p className="font-mono text-sm mt-2 mb-4">You are currently on this plan.</p>
                    <ul className="space-y-2 text-sm text-slate-600 mb-6">
                        <li>• 30 Daily Credits</li>
                        <li>• Standard Speed</li>
                        <li>• Public Gallery Access</li>
                    </ul>
                    <button disabled className="w-full py-2 border-2 border-slate-300 rounded-lg text-slate-400 font-bold">Current Plan</button>
                </div>

                {/* Pro Card (Best Value) */}
                <div className="relative border-4 border-black bg-brand-yellow/10 p-6 rounded-2xl transform hover:-translate-y-1 transition-transform">
                    <div className="absolute -top-4 right-4 bg-brand-yellow border-2 border-black px-3 py-1 text-xs font-bold uppercase shadow-comic animate-pulse">
                        Best Value
                    </div>
                    <h3 className="font-display text-2xl text-black">Pro Annual</h3>
                    <div className="flex items-baseline gap-1 mt-2 mb-4">
                        <span className="text-4xl font-black font-display">$19</span>
                        <span className="text-sm font-bold text-slate-500">/mo</span>
                    </div>
                    <ul className="space-y-2 text-sm text-slate-800 font-medium mb-6">
                        <li className="flex items-center gap-2"><div className="w-4 h-4 bg-green-500 rounded-full flex items-center justify-center text-white text-[10px]">✓</div> Unlimited Generations (BYOK)</li>
                        <li className="flex items-center gap-2"><div className="w-4 h-4 bg-green-500 rounded-full flex items-center justify-center text-white text-[10px]">✓</div> Priority Access</li>
                        <li className="flex items-center gap-2"><div className="w-4 h-4 bg-green-500 rounded-full flex items-center justify-center text-white text-[10px]">✓</div> Private Projects</li>
                    </ul>
                    <Button className="w-full shadow-comic" icon={<CreditCard size={18} />} onClick={() => setActiveTab('settings')}>Upgrade (Enter Key)</Button>
                </div>
            </div>
        </div>
    );

    const renderAdmin = () => (
        <div className="space-y-6 animate-fade-in">
            <div className="bg-slate-100 p-6 rounded-xl border-4 border-black">
                <h3 className="font-display text-2xl mb-4">Coupon Generator</h3>
                <Button onClick={handleGenerateCoupon}>Generate New Code</Button>
            </div>

            <div className="bg-white border-2 border-slate-200 rounded-xl overflow-hidden">
                <table className="w-full text-sm text-left">
                    <thead className="bg-slate-50 border-b-2 border-slate-200">
                        <tr>
                            <th className="p-3 font-bold">Code</th>
                            <th className="p-3 font-bold">Status</th>
                            <th className="p-3 font-bold">Details</th>
                        </tr>
                    </thead>
                    <tbody>
                        {adminCoupons.map(c => (
                            <tr key={c.code} className="border-b border-slate-100 last:border-0">
                                <td className="p-3 font-mono font-bold select-all">{c.code}</td>
                                <td className="p-3">
                                    <span className={`px-2 py-0.5 rounded text-xs font-bold ${c.is_redeemed ? 'bg-red-100 text-red-600' : 'bg-green-100 text-green-600'}`}>
                                        {c.is_redeemed ? 'Redeemed' : 'Active'}
                                    </span>
                                </td>
                                <td className="p-3 text-slate-400 text-xs">{c.is_redeemed ? `By: ${c.redeemed_by}` : '-'}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );

    const renderLegal = () => (
        <div className="space-y-6 animate-fade-in max-w-3xl">
            <div className="bg-white border-2 border-black rounded-xl p-6 h-[400px] overflow-y-auto font-mono text-xs leading-relaxed">
                <h3 className="font-bold text-lg mb-4 underline">Privacy Policy</h3>
                <p><strong>Last Updated: Feb 06, 2026</strong></p>
                <p className="mt-2">DreamStream Inc. ("we", "our") respects your privacy. This policy explains how we handle your data.</p>
                <p className="mt-4 font-bold">1. Data Collection</p>
                <p>We collect your email, username, and generation history. Images generated are stored in your private cloud bucket unless you choose to make them public.</p>
                <p className="mt-4 font-bold">2. AI Usage</p>
                <p>We use third-party AI providers (Google Gemini, Black Forest Labs). Your prompts are sent to these services for generation. We do not use your private data to train our models without consent.</p>
                <p className="mt-4 font-bold">3. Data Security</p>
                <p>All API keys provided by you are encrypted using AES-256 before storage. We cannot see your keys.</p>

                <hr className="my-6 border-slate-200" />

                <h3 className="font-bold text-lg mb-4 underline">Terms of Service</h3>
                <p><strong>1. Acceptance</strong></p>
                <p>By using DreamStream, you agree to these terms.</p>
                <p className="mt-4 font-bold">2. Content Ownership</p>
                <p>You own the rights to the comics you create, subject to the terms of the AI models used (Flux/Gemini). You are responsible for ensuring your content does not violate copyright or safety guidelines.</p>
                <p className="mt-4 font-bold">3. Termination</p>
                <p>We reserve the right to terminate accounts that abuse the API or violate content safety policies.</p>
            </div>
        </div>
    );

    const renderContact = () => {
        const [msg, setMsg] = useState('');
        const [contactEmail, setContactEmail] = useState(user?.email || '');
        const [sent, setSent] = useState(false);

        const send = async (e: React.FormEvent) => {
            e.preventDefault();
            await savePublicContactMessage(contactEmail, msg);
            setSent(true);
        };

        if (sent) return (
            <div className="flex flex-col items-center justify-center py-20 text-center animate-fade-in">
                <div className="w-20 h-20 bg-green-100 text-green-600 rounded-full flex items-center justify-center mb-4 border-4 border-black">
                    <Mail size={40} />
                </div>
                <h3 className="font-display text-2xl">Message Sent!</h3>
                <p className="font-comic text-slate-600 mt-2">A representative will be in touch shortly.</p>
                <button onClick={() => setSent(false)} className="mt-8 text-sm font-bold underline">Send another</button>
            </div>
        );

        return (
            <div className="max-w-xl animate-fade-in">
                <h3 className="font-display text-2xl mb-2">Contact Support</h3>
                <p className="text-slate-500 mb-6 font-comic">Found a bug? Have a feature request? Let us know.</p>
                <form onSubmit={send} className="space-y-4">
                    <div>
                        <label className="font-bold text-xs uppercase">Your Email</label>
                        <input type="email" required value={contactEmail} onChange={e => setContactEmail(e.target.value)}
                            className="w-full mt-1 border-2 border-black rounded-lg px-4 py-2 font-mono" />
                    </div>
                    <div>
                        <label className="font-bold text-xs uppercase">Message (Max 1000 chars)</label>
                        <textarea required maxLength={1000} rows={6} value={msg} onChange={e => setMsg(e.target.value)}
                            className="w-full mt-1 border-2 border-black rounded-lg px-4 py-2 font-mono" />
                        <div className="text-right text-xs text-slate-400 mt-1">{msg.length}/1000</div>
                    </div>
                    <Button type="submit" icon={<Mail size={16} />}>Send Message</Button>
                </form>
            </div>
        );
    };

    // Reuse settings modal inner logic? Or simple manual version
    const renderSettings = () => (
        <div className="space-y-6 animate-fade-in max-w-2xl">
            <div>
                <h3 className="font-display text-xl mb-4">AI Configuration</h3>
                <KeyManager />
            </div>
        </div>
    );

    return (
        <div className="min-h-screen bg-slate-50 pb-20">
            {/* Header */}
            <div className="bg-white border-b-4 border-black sticky top-0 z-30">
                <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-black text-white rounded-lg flex items-center justify-center font-display text-xl">S</div>
                        <h1 className="font-display text-2xl">Account Settings</h1>
                    </div>
                    <button onClick={onClose} className="font-bold hover:underline">Exit</button>
                </div>
            </div>

            <div className="max-w-7xl mx-auto px-6 py-8 grid grid-cols-1 md:grid-cols-4 gap-8">
                {/* Sidebar */}
                <div className="space-y-2">
                    <NavButton icon={<UserIcon size={18} />} label="Profile" active={activeTab === 'profile'} onClick={() => setActiveTab('profile')} />
                    <NavButton icon={<Settings size={18} />} label="API Configuration" active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} />
                    <NavButton icon={<CreditCard size={18} />} label="Billing" active={activeTab === 'billing'} onClick={() => setActiveTab('billing')} />
                    <NavButton icon={<Shield size={18} />} label="Legal" active={activeTab === 'legal'} onClick={() => setActiveTab('legal')} />
                    <NavButton icon={<Mail size={18} />} label="Contact" active={activeTab === 'contact'} onClick={() => setActiveTab('contact')} />

                    <div className="pt-8">
                        <button onClick={signOut} className="w-full flex items-center gap-3 px-4 py-3 rounded-xl font-bold text-red-600 hover:bg-red-50 transition-colors">
                            <LogOut size={18} /> Sign Out
                        </button>
                    </div>
                </div>

                {/* Content */}
                <div className="md:col-span-3 bg-white border-4 border-black rounded-2xl p-8 shadow-comic min-h-[600px]">
                    {loading ? (
                        <div className="flex items-center justify-center h-full">Loading...</div>
                    ) : (
                        <>
                            <h2 className="font-display text-3xl mb-6 capitalize">{activeTab}</h2>
                            {activeTab === 'profile' && renderProfile()}
                            {activeTab === 'settings' && renderSettings()}
                            {activeTab === 'billing' && renderBilling()}
                            {activeTab === 'legal' && renderLegal()}
                            {activeTab === 'contact' && <ContactSection />}
                            {activeTab === ('admin' as any) && renderAdmin()}
                        </>
                    )}
                </div>
            </div>

            {previewAvatar && (
                <div className="fixed inset-0 z-[250] bg-black/80 flex items-center justify-center p-4 backdrop-blur-sm" onClick={() => setPreviewAvatar(null)}>
                    <div className="bg-white p-2 rounded-2xl border-4 border-black shadow-2xl max-w-lg w-full relative">
                        <button
                            onClick={() => setPreviewAvatar(null)}
                            className="absolute -top-4 -right-4 bg-red-500 text-white p-2 rounded-full border-2 border-black hover:bg-red-600 transition-colors"
                        >
                            <X size={20} />
                        </button>
                        <img src={previewAvatar} alt="Avatar Full" className="w-full h-auto rounded-xl" />
                    </div>
                </div>
            )}
        </div>
    );
};

const NavButton = ({ icon, label, active, onClick }: any) => (
    <button
        onClick={onClick}
        className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl font-bold transition-all ${active ? 'bg-black text-white shadow-comic transform -translate-y-1' : 'bg-transparent text-slate-500 hover:bg-slate-200'}`}
    >
        {icon} {label}
    </button>
);
