const express = require('express');
const cors = require('cors');
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

const serviceAccount = require('./serviceAccountKey.json');

initializeApp({
  credential: cert(serviceAccount),
});
const auth = getAuth();
const db = getFirestore();

const app = express();

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'PharmaCare API is running!',
  });
});

async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Authorization token missing',
      });
    }

    const token = authHeader.split(' ')[1];

    const decodedToken = await auth.verifyIdToken(token);

    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(401).json({
      success: false,
      message: 'Invalid or expired token',
    });
  }
}

app.get('/api/profile', verifyToken, (req, res) => {
  res.json({
    success: true,
    message: 'User authenticated successfully!',
    uid: req.user.uid,
  });
});

app.get('/api/medicines', verifyToken, async (req, res) => {
  try {
    const snapshot = await db
        .collection('medicines')
        .where('userId', '==', req.user.uid)
        .get();

    const medicines = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).json({
      success: true,
      count: medicines.length,
      medicines: medicines,
    });

  } catch (error) {
    console.error('Get Medicines Error:', error);

    res.status(500).json({
      success: false,
      message: 'Failed to fetch medicines',
    });
  }
});

// POST
app.post('/api/medicines', verifyToken, async (req, res) => {
  try {
    const {
      name,
      category,
      description,
      price,
      stock,
      minimumStock,
      expiryDate,
    } = req.body;

    // Required field validation
    if (!name || price == null || stock == null) {
      return res.status(400).json({
        success: false,
        message: 'Name, price and stock are required',
      });
    }

    const medicineData = {
      name: name,
      category: category || '',
      description: description || '',
      price: Number(price),
      stock: Number(stock),
      minimumStock: Number(minimumStock || 0),
      expiryDate: expiryDate || '',
      userId: req.user.uid,
      createdAt: new Date(),
    };

    const docRef = await db
        .collection('medicines')
        .add(medicineData);

    res.status(201).json({
      success: true,
      message: 'Medicine added successfully!',
      medicineId: docRef.id,
      medicine: medicineData,
    });

  } catch (error) {
    console.error('Add Medicine Error:', error);

    res.status(500).json({
      success: false,
      message: 'Failed to add medicine',
    });
  }
});

// UPDATE MEDICINE API
app.put('/api/medicines/:id', verifyToken, async (req, res) => {
  try {
    const medicineId = req.params.id;

    const {
      name,
      category,
      description,
      price,
      stock,
      minimumStock,
      expiryDate,
    } = req.body;

    // Find medicine
    const medicineRef = db.collection('medicines').doc(medicineId);
    const medicineDoc = await medicineRef.get();

    if (!medicineDoc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Medicine not found',
      });
    }

    // Check ownership
    if (medicineDoc.data().userId !== req.user.uid) {
      return res.status(403).json({
        success: false,
        message: 'You are not allowed to update this medicine',
      });
    }

    // Update data
    const updateData = {};

    if (name !== undefined) updateData.name = name;
    if (category !== undefined) updateData.category = category;
    if (description !== undefined) updateData.description = description;
    if (price !== undefined) updateData.price = Number(price);
    if (stock !== undefined) updateData.stock = Number(stock);
    if (minimumStock !== undefined) {
      updateData.minimumStock = Number(minimumStock);
    }
    if (expiryDate !== undefined) updateData.expiryDate = expiryDate;

    updateData.updatedAt = new Date();

    await medicineRef.update(updateData);

    res.status(200).json({
      success: true,
      message: 'Medicine updated successfully!',
      medicineId: medicineId,
    });

  } catch (error) {
    console.error('Update Medicine Error:', error);

    res.status(500).json({
      success: false,
      message: 'Failed to update medicine',
    });
  }
});

// DELETE Medicine
app.delete('/api/medicines/:id', verifyToken, async (req, res) => {
  try {
    const medicineId = req.params.id;

    const medicineRef = db.collection('medicines').doc(medicineId);
    const medicineDoc = await medicineRef.get();

    if (!medicineDoc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Medicine not found',
      });
    }

    if (medicineDoc.data().userId !== req.user.uid) {
      return res.status(403).json({
        success: false,
        message: 'You are not allowed to delete this medicine',
      });
    }

    await medicineRef.delete();

    res.status(200).json({
      success: true,
      message: 'Medicine deleted successfully',
    });

  } catch (error) {
    console.error('Delete Medicine Error:', error);

    res.status(500).json({
      success: false,
      message: 'Failed to delete medicine',
    });
  }
});

// POST Sale + Automatic Medicine Stock Update
app.post('/api/sales', verifyToken, async (req, res) => {
  try {
    const { patientName, items } = req.body;

    if (!patientName || !patientName.trim()) {
      return res.status(400).json({
        success: false,
        message: 'Patient name is required',
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Sale items are required',
      });
    }

    const saleRef = db.collection('sales').doc();

    let totalAmount = 0;

    const saleItems = items.map(item => {
      const quantity = Number(item.quantity);
      const price = Number(item.price);

      if (
        !item.id ||
        !Number.isInteger(quantity) ||
        quantity <= 0 ||
        !Number.isFinite(price) ||
        price < 0
      ) {
        throw new Error('Invalid sale item details');
      }

      totalAmount += quantity * price;

      return {
        id: item.id,
        name: item.name,
        quantity,
        price,
      };
    });

    await db.runTransaction(async transaction => {
      const medicineRefs = saleItems.map(item =>
        db.collection('medicines').doc(item.id)
      );

      const snapshots = [];

      for (const ref of medicineRefs) {
        snapshots.push(await transaction.get(ref));
      }

      const updatedStocks = [];

      for (let i = 0; i < snapshots.length; i++) {
        const snapshot = snapshots[i];

        if (!snapshot.exists) {
          throw new Error(`${saleItems[i].name} not found`);
        }

        const medicine = snapshot.data();

        if (medicine.userId !== req.user.uid) {
          throw new Error('Unauthorized medicine access');
        }

        const stock = Number(medicine.stock ?? medicine.quantity ?? 0);
        const soldQuantity = saleItems[i].quantity;

        if (!Number.isInteger(stock) || stock < soldQuantity) {
          throw new Error(
            `Insufficient stock for ${saleItems[i].name}. Available: ${stock}`
          );
        }

        updatedStocks.push(stock - soldQuantity);
      }

      for (let i = 0; i < medicineRefs.length; i++) {
        transaction.update(medicineRefs[i], {
          stock: updatedStocks[i],
        });
      }

      transaction.set(saleRef, {
        invoiceId: saleRef.id,
        userId: req.user.uid,
        patientName: patientName.trim(),
        items: saleItems,
        subtotal: totalAmount,
        discount: 0,
        totalAmount,
        createdAt: new Date(),
        status: 'completed',
      });
    });

    res.status(201).json({
      success: true,
      message: 'Sale completed successfully',
      invoiceId: saleRef.id,
      totalAmount,
    });

  } catch (error) {
    console.error('Complete Sale Error:', error);

    res.status(400).json({
      success: false,
      message: error.message || 'Sale failed',
    });
  }
});


// GET Sales History
app.get('/api/sales', verifyToken, async (req, res) => {
  try {
    const snapshot = await db.collection('sales')
      .where('userId', '==', req.user.uid)
      .orderBy('createdAt', 'desc')
      .get();

    const sales = snapshot.docs.map(doc => {
      const data = doc.data();

      return {
        id: doc.id,
        ...data,
        createdAt: data.createdAt
          ? data.createdAt.toDate().toISOString()
          : null,
      };
    });

    res.status(200).json({
      success: true,
      sales,
    });
  } catch (error) {
    console.error('Get Sales Error:', error);

    res.status(500).json({
      success: false,
      message: error.message || 'Sales could not be loaded',
    });
  }
});


/// SUPPLIER

// 1. ADD SUPPLIER
app.post('/api/suppliers', verifyToken, async (req, res) => {
  try {
    const {
      name,
      contact,
      email,
      companyAddress,
      city,
      country,
      taxId,
      paymentTerms,
      notes,
    } = req.body;

    if (!name || !contact) {
      return res.status(400).json({
        success: false,
        message: 'Supplier name and contact are required',
      });
    }

    const supplierData = {
      name: name.trim(),
      contact: contact.trim(),
      email: email || '',
      companyAddress: companyAddress || '',
      city: city || '',
      country: country || '',
      taxId: taxId || '',
      paymentTerms: paymentTerms || '',
      notes: notes || '',
      userId: req.user.uid,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const docRef = await db.collection('suppliers').add(supplierData);

    res.status(201).json({
      success: true,
      message: 'Supplier added successfully',
      supplierId: docRef.id,
      supplier: {
        id: docRef.id,
        ...supplierData,
        createdAt: supplierData.createdAt.toISOString(),
        updatedAt: supplierData.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    console.error('Add Supplier Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Supplier could not be added',
    });
  }
});


// 2. GET SUPPLIERS
app.get('/api/suppliers', verifyToken, async (req, res) => {
  try {
    const snapshot = await db.collection('suppliers')
      .where('userId', '==', req.user.uid)
      .get();

    const suppliers = snapshot.docs.map(doc => {
      const data = doc.data();

      return {
        id: doc.id,
        ...data,
        createdAt: data.createdAt
          ? data.createdAt.toDate().toISOString()
          : null,
        updatedAt: data.updatedAt
          ? data.updatedAt.toDate().toISOString()
          : null,
      };
    });

    suppliers.sort((a, b) =>
      new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    );

    res.status(200).json({
      success: true,
      suppliers,
    });
  } catch (error) {
    console.error('Get Suppliers Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Suppliers could not be loaded',
    });
  }
});


// 3. UPDATE SUPPLIER
app.put('/api/suppliers/:id', verifyToken, async (req, res) => {
  try {
    const supplierId = req.params.id;

    const supplierRef = db.collection('suppliers').doc(supplierId);
    const supplierDoc = await supplierRef.get();

    if (!supplierDoc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found',
      });
    }

    if (supplierDoc.data().userId !== req.user.uid) {
      return res.status(403).json({
        success: false,
        message: 'You cannot update this supplier',
      });
    }

    const allowedFields = [
      'name',
      'contact',
      'email',
      'companyAddress',
      'city',
      'country',
      'taxId',
      'paymentTerms',
      'notes',
    ];

    const updateData = {};

    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updateData[field] = req.body[field];
      }
    });

    if (updateData.name !== undefined &&
        !String(updateData.name).trim()) {
      return res.status(400).json({
        success: false,
        message: 'Supplier name is required',
      });
    }

    updateData.updatedAt = new Date();

    await supplierRef.update(updateData);

    res.status(200).json({
      success: true,
      message: 'Supplier updated successfully',
    });
  } catch (error) {
    console.error('Update Supplier Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Supplier could not be updated',
    });
  }
});


// 4. DELETE SUPPLIER
app.delete('/api/suppliers/:id', verifyToken, async (req, res) => {
  try {
    const supplierId = req.params.id;

    const supplierRef = db.collection('suppliers').doc(supplierId);
    const supplierDoc = await supplierRef.get();

    if (!supplierDoc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Supplier not found',
      });
    }

    if (supplierDoc.data().userId !== req.user.uid) {
      return res.status(403).json({
        success: false,
        message: 'You cannot delete this supplier',
      });
    }

    await supplierRef.delete();

    res.status(200).json({
      success: true,
      message: 'Supplier deleted successfully',
    });
  } catch (error) {
    console.error('Delete Supplier Error:', error);
    res.status(500).json({
      success: false,
      message: error.message || 'Supplier could not be deleted',
    });
  }
});



// ADD EXPENSE
app.post('/api/expenses', verifyToken, async (req, res) => {
  try {
    const { title, amount, date } = req.body;

    if (!title || !amount || !date) {
      return res.status(400).json({
        success: false,
        message: 'Title, amount and date are required',
      });
    }

    const expenseAmount = Number(amount);

    if (!Number.isFinite(expenseAmount) || expenseAmount <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Please enter a valid amount',
      });
    }

    const docRef = await db.collection('expenses').add({
      title: title.trim(),
      amount: expenseAmount,
      date: date,
      userId: req.user.uid,
      createdAt: new Date(),
    });

    res.status(201).json({
      success: true,
      message: 'Expense added successfully',
      expenseId: docRef.id,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});


// GET ALL EXPENSES
app.get('/api/expenses', verifyToken, async (req, res) => {
  try {
    const snapshot = await db.collection('expenses')
      .where('userId', '==', req.user.uid)
      .get();

    const expenses = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    expenses.sort((a, b) =>
      new Date(b.createdAt).getTime() -
      new Date(a.createdAt).getTime()
    );

    res.status(200).json({
      success: true,
      expenses,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});


// UPDATE EXPENSE
app.put('/api/expenses/:id', verifyToken, async (req, res) => {
  try {
    const { title, amount, date } = req.body;
    const expenseRef = db.collection('expenses').doc(req.params.id);
    const expenseDoc = await expenseRef.get();

    if (!expenseDoc.exists ||
        expenseDoc.data().userId !== req.user.uid) {
      return res.status(404).json({
        success: false,
        message: 'Expense not found',
      });
    }

    const expenseAmount = Number(amount);

    if (!title?.trim() || !Number.isFinite(expenseAmount) ||
        expenseAmount <= 0 || !date) {
      return res.status(400).json({
        success: false,
        message: 'Valid title, amount and date are required',
      });
    }

    await expenseRef.update({
      title: title.trim(),
      amount: expenseAmount,
      date,
      updatedAt: new Date(),
    });

    res.status(200).json({
      success: true,
      message: 'Expense updated successfully',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});


// DELETE EXPENSE
app.delete('/api/expenses/:id', verifyToken, async (req, res) => {
  try {
    const expenseRef = db.collection('expenses').doc(req.params.id);
    const expenseDoc = await expenseRef.get();

    if (!expenseDoc.exists ||
        expenseDoc.data().userId !== req.user.uid) {
      return res.status(404).json({
        success: false,
        message: 'Expense not found',
      });
    }

    await expenseRef.delete();

    res.status(200).json({
      success: true,
      message: 'Expense deleted successfully',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});




// GET: Load user settings
app.get('/api/settings', verifyToken, async (req, res) => {
  try {
    const doc = await db.collection('users').doc(req.user.uid).get();

    const data = doc.data() || {};

    const defaultSettings = {
      language: 'English',
      theme: 'Light',
      dateFormat: 'dd-MM-yyyy',
      paymentMethod: 'Cash',
      lowStockNotifications: true,
      salesNotifications: true,
      expenseNotifications: true,
    };

    res.status(200).json({
      success: true,
      settings: {
        ...defaultSettings,
        ...(data.appSettings || {}),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// PUT: Update user settings
app.put('/api/settings', verifyToken, async (req, res) => {
  try {
    const {
      language,
      theme,
      dateFormat,
      paymentMethod,
      lowStockNotifications,
      salesNotifications,
      expenseNotifications,
    } = req.body;

    const allowedLanguages = ['English', 'Urdu'];
    const allowedThemes = ['Light', 'Dark'];
    const allowedDateFormats = [
      'dd-MM-yyyy',
      'MM-dd-yyyy',
      'yyyy-MM-dd',
      'dd/MM/yyyy',
    ];
    const allowedPaymentMethods = [
      'Cash',
      'Bank Transfer',
      'JazzCash',
      'EasyPaisa',
      'Debit/Credit Card',
    ];

    const updates = {};

    if (language !== undefined) {
      if (!allowedLanguages.includes(language)) {
        return res.status(400).json({ success: false, message: 'Invalid language' });
      }
      updates['appSettings.language'] = language;
    }

    if (theme !== undefined) {
      if (!allowedThemes.includes(theme)) {
        return res.status(400).json({ success: false, message: 'Invalid theme' });
      }
      updates['appSettings.theme'] = theme;
    }

    if (dateFormat !== undefined) {
      if (!allowedDateFormats.includes(dateFormat)) {
        return res.status(400).json({ success: false, message: 'Invalid date format' });
      }
      updates['appSettings.dateFormat'] = dateFormat;
    }

    if (paymentMethod !== undefined) {
      if (!allowedPaymentMethods.includes(paymentMethod)) {
        return res.status(400).json({ success: false, message: 'Invalid payment method' });
      }
      updates['appSettings.paymentMethod'] = paymentMethod;
    }

    for (const key of [
      'lowStockNotifications',
      'salesNotifications',
      'expenseNotifications',
    ]) {
      if (req.body[key] !== undefined) {
        if (typeof req.body[key] !== 'boolean') {
          return res.status(400).json({ success: false, message: `Invalid ${key}` });
        }
        updates[`appSettings.${key}`] = req.body[key];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No settings provided',
      });
    }

    await db.collection('users').doc(req.user.uid).update(updates)
      .catch(async (error) => {
        if (error.code === 5) {
          await db.collection('users').doc(req.user.uid).set({
            appSettings: {
              ...req.body,
            },
          }, { merge: true });
        } else {
          throw error;
        }
      });

    res.status(200).json({
      success: true,
      message: 'Settings updated successfully',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// PUT: Update user profile
app.put('/api/profile', verifyToken, async (req, res) => {
  try {
    const name = req.body.name?.trim();

    if (!name) {
      return res.status(400).json({
        success: false,
        message: 'Name is required',
      });
    }

    const uid = req.user.uid;

    // Firebase Authentication mein display name update
    await auth.updateUser(uid, {
      displayName: name,
    });

    // Firestore mein profile update
    await db.collection('users').doc(uid).set({
      name: name,
      email: req.user.email || '',
      updatedAt: new Date(),
    }, { merge: true });

    res.status(200).json({
      success: true,
      message: 'Profile updated successfully',
      profile: {
        name: name,
        email: req.user.email || '',
      },
    });

  } catch (error) {
    console.error('Profile update error:', error);

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// DASHBOARD SUMMARY API
app.get('/api/dashboard/summary', verifyToken, async (req, res) => {
  try {
    const uid = req.user.uid;

    const [salesSnapshot, medicinesSnapshot] = await Promise.all([
      db.collection('sales')
        .where('userId', '==', uid)
        .get(),

      db.collection('medicines')
        .where('userId', '==', uid)
        .get(),
    ]);

    let totalSales = 0;

    salesSnapshot.forEach(doc => {
      const data = doc.data();
      totalSales += Number(data.totalAmount || 0);
    });

    const totalProducts = medicinesSnapshot.size;

    res.status(200).json({
      success: true,
      summary: {
        totalSales: totalSales,
        totalProducts: totalProducts,
      },
    });

  } catch (error) {
    console.error('Dashboard Summary Error:', error);

    res.status(500).json({
      success: false,
      message: 'Dashboard data could not be loaded',
    });
  }
});

app.get('/api/dashboard/summary', verifyToken, async (req, res) => {
  try {
    const uid = req.user.uid;

    const [salesSnapshot, medicinesSnapshot] = await Promise.all([
      db.collection('sales').where('userId', '==', uid).get(),
      db.collection('medicines').where('userId', '==', uid).get(),
    ]);

    let totalSales = 0;

    salesSnapshot.forEach((doc) => {
      totalSales += Number(doc.data().totalAmount || 0);
    });

    res.status(200).json({
      success: true,
      summary: {
        totalSales,
        totalProducts: medicinesSnapshot.size,
      },
    });
  } catch (error) {
    console.error('Dashboard Summary Error:', error);

    res.status(500).json({
      success: false,
      message: 'Dashboard data could not be loaded',
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`PharmaCare API running on port ${PORT}`);
});