// src/index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

// Recursively fetch all linked contacts
async function findAllLinkedContacts(contactId) {
  const linked = await prisma.contact.findMany({
    where: { OR: [{ id: contactId }, { linkedId: contactId }] }
  });
  const secondaries = await Promise.all(
    linked
      .filter(c => c.linkPrecedence === 'SECONDARY')   // <-- uppercase here
      .map(c => findAllLinkedContacts(c.id))
  );
  return [...linked, ...secondaries.flat()];
}

app.post('/identify', async (req, res) => {
  const { email, phoneNumber } = req.body;
  if (!email && !phoneNumber) {
    return res.status(400).json({ error: 'Provide email or phoneNumber' });
  }

  // 1) find matches
  let matches = await prisma.contact.findMany({
    where: {
      OR: [
        { email: email || undefined },
        { phoneNumber: phoneNumber || undefined }
      ],
      deletedAt: null
    },
    orderBy: { createdAt: 'asc' }
  });

  // 2) no match → new primary
  if (!matches.length) {
    const primary = await prisma.contact.create({
      data: { email, phoneNumber, linkPrecedence: 'PRIMARY' }  // <-- uppercase here
    });
    return res.json({
      contact: {
        primaryContactId: primary.id,
        emails: [primary.email].filter(Boolean),
        phoneNumbers: [primary.phoneNumber].filter(Boolean),
        secondaryContactIds: []
      }
    });
  }

  // 3) resolve primary
  let primary = matches.find(c => c.linkPrecedence === 'PRIMARY');  // <-- uppercase here
  if (!primary) {
    primary = await prisma.contact.findUnique({
      where: { id: matches[0].linkedId }
    });
  }

  // 4) demote any other primaries
  const others = matches.filter(c => c.linkPrecedence === 'PRIMARY' && c.id !== primary.id); // <-- uppercase here
  if (others.length) {
    const ids = others.map(o => o.id);
    await prisma.contact.updateMany({
      where: { id: { in: ids } },
      data: { linkPrecedence: 'SECONDARY', linkedId: primary.id }  // <-- uppercase here
    });
    await prisma.contact.updateMany({
      where: { linkedId: { in: ids } },
      data: { linkedId: primary.id }
    });
  }

  // 5) fetch entire cluster
  let cluster = await findAllLinkedContacts(primary.id);

  // 6) add new secondary if needed
  const exists = cluster.some(c =>
    (email && c.email === email) || (phoneNumber && c.phoneNumber === phoneNumber)
  );
  if (!exists) {
    await prisma.contact.create({
      data: { email, phoneNumber, linkPrecedence: 'SECONDARY', linkedId: primary.id }  // <-- uppercase here
    });
    cluster = await findAllLinkedContacts(primary.id);
  }

  // 7) build response
  const emails = new Set();
  const phones = new Set();
  const secondaryIds = [];

  cluster.forEach(c => {
    if (c.linkPrecedence === 'SECONDARY') secondaryIds.push(c.id);  // <-- uppercase here
    if (c.email) emails.add(c.email);
    if (c.phoneNumber) phones.add(c.phoneNumber);
  });

  return res.json({
    contact: {
      primaryContactId: primary.id,
      emails: Array.from(emails),
      phoneNumbers: Array.from(phones),
      secondaryContactIds: secondaryIds
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
