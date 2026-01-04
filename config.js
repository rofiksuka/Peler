// HAPUS TOKEN DAN PASSWORD DARI SINI SETELAH LU COPY
// GANTI DENGAN TOKEN/PASSWORD BARU LU YANG AMAN

module.exports = {

    telegramBotToken: '8270916688:AAFc9WTF9DqFM_0Eww1U1U1FLWDLWMXRESY', // GANTI INI
    ownerId: 8446734557,
    
    // TAMBAHKAN INI (WAJIB)
    ownerUsername: 'sarungcolok', // Cth: 'usernameOwner'
    channelUsername: 'rofikcial', // Cth: 'channelInfo'

    // Objek emailConfig dihapus karena sudah diatur via command
    
    photoStart: 'https://iili.io/KrKY5AB.jpg',

    message: {
        wait: "⏳ Sabar ya bos, lagi diproses...",
        error: "❌ Terjadi kesalahan, coba lagi nanti.",
        premium: "👑 Fitur ini khusus untuk member premium.",
        // Ini pesan baru di kode baru, tapi udah gw masukin di kode full fix:
        waNotConnected: "🤖 WhatsApp sender pribadi belum tersambung atau belum diatur. Cek /pairingsender, /listsender, dan /setsender.",
        selfMode: "🔒 Maaf, bot sedang dalam mode pribadi.",
        maintenance: "🔧 Bot sedang dalam perbaikan. Coba lagi nanti ya.",
        commandOff: "❌ Perintah ini sedang dinaktifkan oleh Owner.",
        cooldown: (remaining) => `🧊 Santai dulu bos, tunggu ${remaining} detik lagi.`,
        groupNotAllowed: "🚫 Bot ini tidak diizinkan di grup ini. Silakan hubungi Owner untuk mendaftarkan grup." // Tambahan dari kode baru
    },

    defaultSettings: {
        maintenance: false,
        botMode: 'public', // 'public' atau 'self'
        activeSender: null, // ID sesi WA Global (Hanya Owner Utama yang bisa set)
        cekBioBatchSize: 5, // Ini akan dipakai oleh bot utama
        cooldowns: {
            default: 10,
            premium: 3,
        },
        commands: {
            cekbio: true,
            cekbiotxt: true,
            ceknumber: true,
            fixmerah: true,
            tiktok: true,
            tourl: true,
            stiker: true,
    
            pointsPerReferral: 10, 
            pairingsender: true,
            listsender: true,
            setsender: true,
        }
    }
};
