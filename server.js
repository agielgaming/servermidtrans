require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const midtransClient = require('midtrans-client');

const app = express();
app.use(cors()); // di production, batasi origin ke domain bromostory.com kamu saja
app.use(express.json());

// ---------- "Database" sederhana (file JSON) ----------
// Untuk produksi nyata, ganti dengan database asli (PostgreSQL, MongoDB, dll).
const DB_FILE = path.join(__dirname, 'bookings.json');

function readBookings() {
  if (!fs.existsSync(DB_FILE)) return [];
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
}
function writeBookings(bookings) {
  fs.writeFileSync(DB_FILE, JSON.stringify(bookings, null, 2));
}

// ---------- Midtrans Snap client ----------
const snap = new midtransClient.Snap({
  isProduction: process.env.MIDTRANS_IS_PRODUCTION === 'true',
  serverKey: process.env.MIDTRANS_SERVER_KEY,
  clientKey: process.env.MIDTRANS_CLIENT_KEY,
});

// ---------- Buat transaksi baru ----------
app.post('/api/create-transaction', async (req, res) => {
  try {
    const {
      nama, email, telp,
      paketId, paketNama,
      jumlah, hargaSatuan,
      tanggal, catatan,
    } = req.body;

    if (!nama || !email || !telp || !paketId || !jumlah || !hargaSatuan) {
      return res.status(400).json({ error: 'Data booking tidak lengkap.' });
    }

    const jumlahNum = parseInt(jumlah, 10);
    const hargaNum = parseInt(hargaSatuan, 10);
    const total = jumlahNum * hargaNum;
    const orderId = `BRS-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

    const parameter = {
      transaction_details: {
        order_id: orderId,
        gross_amount: total,
      },
      credit_card: { secure: true },
      customer_details: {
        first_name: nama,
        email,
        phone: telp,
      },
      item_details: [
        {
          id: paketId,
          price: hargaNum,
          quantity: jumlahNum,
          name: paketNama.substring(0, 50), // Midtrans batasi 50 karakter
        },
      ],
      callbacks: {
        // halaman yang dilihat user setelah selesai bayar (opsional)
        finish: process.env.FRONTEND_URL || 'https://bromostory.com',
      },
    };

    const transaction = await snap.createTransaction(parameter);

    const bookings = readBookings();
    bookings.push({
      orderId,
      nama, email, telp,
      paketId, paketNama,
      jumlah: jumlahNum, hargaSatuan: hargaNum, total,
      tanggal, catatan: catatan || '',
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    writeBookings(bookings);

    res.json({
      token: transaction.token,
      redirect_url: transaction.redirect_url,
      orderId,
    });
  } catch (err) {
    console.error('create-transaction error:', err.message);
    res.status(500).json({ error: 'Gagal membuat transaksi pembayaran.' });
  }
});

// ---------- Webhook notifikasi dari Midtrans ----------
// Daftarkan URL ini (https://domain-backend-kamu/api/notification) di:
// Midtrans Dashboard > Settings > Configuration > Payment Notification URL
app.post('/api/notification', async (req, res) => {
  try {
    const statusResponse = await snap.transaction.notification(req.body);
    const orderId = statusResponse.order_id;
    const transactionStatus = statusResponse.transaction_status;
    const fraudStatus = statusResponse.fraud_status;

    let bookingStatus = 'pending';
    if (transactionStatus === 'capture') {
      bookingStatus = fraudStatus === 'accept' ? 'paid' : 'challenge';
    } else if (transactionStatus === 'settlement') {
      bookingStatus = 'paid';
    } else if (['cancel', 'deny', 'expire'].includes(transactionStatus)) {
      bookingStatus = 'failed';
    } else if (transactionStatus === 'pending') {
      bookingStatus = 'pending';
    }

    const bookings = readBookings();
    const idx = bookings.findIndex((b) => b.orderId === orderId);
    if (idx !== -1) {
      bookings[idx].status = bookingStatus;
      bookings[idx].updatedAt = new Date().toISOString();
      writeBookings(bookings);
      console.log(`Booking ${orderId} -> status: ${bookingStatus}`);
    }

    res.status(200).send('OK');
  } catch (err) {
    console.error('notification error:', err.message);
    res.status(500).send('Error');
  }
});

// ---------- Cek status booking (dipakai frontend untuk konfirmasi) ----------
app.get('/api/booking-status/:orderId', (req, res) => {
  const bookings = readBookings();
  const booking = bookings.find((b) => b.orderId === req.params.orderId);
  if (!booking) return res.status(404).json({ error: 'Booking tidak ditemukan.' });
  res.json(booking);
});

// ---------- Lihat semua booking (sederhana, untuk admin) ----------
// Di produksi, tambahkan autentikasi sebelum endpoint ini bisa diakses publik.
app.get('/api/bookings', (req, res) => {
  res.json(readBookings());
});

app.get('/', (req, res) => {
  res.send('Bromo Story payment backend is running.');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server jalan di port ${PORT}`));
