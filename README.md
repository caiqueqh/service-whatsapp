# Qualitas WhatsApp Web Service 📱

Microserviço em Node.js criado para manter a sessão do WhatsApp Web conectada via QR Code e realizar envios automáticos para os candidatos no sistema Qualitas.

## 🚀 Como Hospedar Grátis no Render (Passo a Passo)

1. Crie um repositório privado ou público no seu GitHub chamado `qualitas-whatsapp-service` e faça o push desta pasta.
2. Acesse [render.com](https://render.com) e crie uma conta gratuita (se ainda não tiver).
3. No painel do Render, clique em **New +** -> **Web Service**.
4. Conecte sua conta do GitHub e selecione o repositório `qualitas-whatsapp-service`.
5. Preencha os campos da seguinte forma:
   - **Name:** `qualitas-whatsapp` (ou o nome que preferir)
   - **Region:** Ohio (ou qualquer uma)
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** **Free** ($0/month)
6. Clique no botão verde **Create Web Service**.
7. Após cerca de 2 minutos, o serviço estará online e gerará um link no topo, por exemplo: `https://qualitas-whatsapp.onrender.com`.

---

## 🛡️ Como Configurar o Ping (Para Nunca Adormecer)

Como o plano gratuito do Render adormece após 15 minutos sem requisições, faremos um robô pingar no link a cada 5 minutos:

1. Acesse [uptimerobot.com](https://uptimerobot.com) e crie uma conta gratuita.
2. Clique em **Add New Monitor**.
3. Preencha:
   - **Monitor Type:** `HTTP(s)`
   - **Friendly Name:** `WhatsApp Qualitas Render Ping`
   - **URL (ou IP):** Cole a URL gerada pelo Render (ex: `https://qualitas-whatsapp.onrender.com`)
   - **Monitoring Interval:** `5 minutes`
4. Clique em **Create Monitor**.

Pronto! Seu serviço rodará 24 horas por dia gratuitamente e o WhatsApp Web não cairá por inatividade.

---

## ⚙️ Variável de Ambiente no Next.js (`qh-interno`)

No arquivo `.env` ou nas variáveis da Vercel do repositório `qh-interno`, adicione a URL do serviço:

```env
WHATSAPP_SERVICE_URL="https://qualitas-whatsapp.onrender.com"
```
*(Para testes locais no computador, pode deixar: `WHATSAPP_SERVICE_URL="http://localhost:3002"`)*
