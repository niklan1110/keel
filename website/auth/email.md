# Email setup

Keel sends emails for sign-up confirmation, magic links, password resets, invites and email changes. Sign-up with a password works without a mail server; add SMTP details when users need to receive those emails, and use [Mailpit](#testing-with-mailpit) to see them while you develop.

```bash
# .env: one mail server for every project
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=no-reply@example.com
SMTP_PASS=your-smtp-password
SMTP_FROM="My App <no-reply@example.com>"
```

## Without a mail server

This is how a new Keel install behaves:

- **New accounts are confirmed right away.** **Confirm email addresses** defaults to off, since nobody could receive the email. On a server the internet can reach, that means anyone can sign up: see [Confirming email addresses](/auth/passwords#confirming-email-addresses). New projects on a public URL start with sign-ups off until you set up a mail server.
- **Other emails are not sent, and their links are not logged.** Magic links, password resets, email changes (and confirmations, if you switch confirmation on) are dropped. Anyone can ask for a reset or magic link for any address, so writing the link to a log would let whoever reads the logs into that account. The API answers as usual, and the `keel-auth` log notes that an email wasn't sent, with the address masked.
- **Studio shows links to share.** **Invite** and **Password reset link** in Studio's Users panel show the link on screen, once, for you to send yourself. Studio's Users panel also says when no mail server is set up.

```text
2026-10-03T09:12:44.120Z WARN  SMTP is not configured; recovery email was not sent project=my-app to=a***@example.com
```

That's enough for a family app or a tool only you use, where you create users yourself. For anyone else, set up SMTP. While you develop, [Mailpit](#testing-with-mailpit) catches every email Keel sends, links included.

## SMTP for every project

Put the mail server in `.env` and run `./keel up` to apply it. Every project uses it unless it has its own server set in Studio.

| Variable | Default | What it is |
|---|---|---|
| `SMTP_HOST` | empty | Mail server host name. Empty means no mail server. |
| `SMTP_PORT` | `587` | Port. 587 upgrades to TLS with STARTTLS when the server offers it; 465 uses TLS from the start. |
| `SMTP_USER`, `SMTP_PASS` | empty | Login. Leave both empty for servers without authentication. |
| `SMTP_FROM` | `Keel <no-reply@keel.local>` | Sender, as `Name <address>` or a plain address |
| `SMTP_SECURE` | `false` | `true` uses TLS from the start on any port (port 465 always does) |

## SMTP for one project

In Studio, open **Users**, click the gear icon (**Sign-in settings**) and fill in **Mail server**: **SMTP host**, **Port**, **Username**, **Password**, **From** and **Use TLS from the start (port 465)**. Click **Save settings**. When a project has an SMTP host here, it uses this server instead of the one in `.env`, which lets each project send from its own address. Clear the host to go back to the `.env` server.

The password is never shown again after saving; leave the field empty to keep it.

Once a mail server is configured, **Confirm email addresses** turns on by default. You can still switch it off if you want sign-ups without confirmation.

## The sender address

Use a **From** address on a domain your mail provider is allowed to send for. Most providers ask you to verify the domain and add SPF and DKIM records to its DNS; without them, Keel's emails tend to land in spam or get rejected.

## What Keel sends

| Email | Subject | Sent when |
|---|---|---|
| Confirmation | Confirm your signup | `signUp` with confirmation on, `signInWithOtp` for a new or unconfirmed address, `resend({ type: 'signup' })` |
| Magic link | Your sign-in link | `signInWithOtp` for a confirmed address |
| Password reset | Reset your password | `resetPasswordForEmail`, Studio's **Password reset link** |
| Invite | You have been invited | `inviteUserByEmail`, Studio's **Invite** |
| Email change | Confirm your new email | `updateUser({ email })` with confirmation on, `resend({ type: 'email_change' })` |

Each email has the project name at the top, a short message, a button with the link and the 6-digit code, in HTML and plain text. Links and codes work once, for an hour. The links point at `KEEL_PUBLIC_URL`, so set it to an address your users can reach (see [Configuration](/self-hosting/configuration)). Where the link sends people afterwards is decided by the [Site URL and redirect URLs](/auth/overview#site-url-and-redirect-urls).

Keel sends at most one email of each kind to a user per minute, and at most 6 auth emails per address per hour.

### Templates

The subjects and wording are fixed, in English, and can't be customized. For emails you trigger from your own server, such as invites or welcome links, you can send your own instead: [`generateLink`](/auth/managing-users#generating-links) returns the link and code without sending anything.

```js
const { data } = await admin.auth.admin.generateLink({
  type: 'invite',
  email: 'grace@example.com',
  options: { redirectTo: 'https://app.example.com/welcome' },
})

await sendMyOwnEmail('grace@example.com', {
  link: data.properties.action_link,
  code: data.properties.email_otp,
})
```

Emails that users trigger themselves (`signUp`, `signInWithOtp`, `resetPasswordForEmail`) always use Keel's built-in text.

## Testing with Mailpit

[Mailpit](https://mailpit.axllent.org) is a mail server for testing: it accepts every email and shows it in a web inbox instead of delivering it. Run it on Keel's Docker network so `keel-auth` can reach it by name:

```bash
docker run -d --name mailpit --network keel_default -p 8025:8025 axllent/mailpit
```

Then, in **Users** > **Sign-in settings** > **Mail server**, set **SMTP host** to `mailpit` and **Port** to `1025`, leave username and password empty, and save. Sign up a test user and open `http://localhost:8025` to see the email. MailHog works the same way, with the same ports.

`keel_default` is the network of a stack started with `./keel up`. `localhost` doesn't work as the SMTP host, because inside the `keel-auth` container it means the container itself; for a mail server elsewhere on your network, use its IP address or host name.

## Common providers

| Provider | SMTP host | Port | Username | Password |
|---|---|---|---|---|
| Gmail or Google Workspace | `smtp.gmail.com` | 587 | Your address | An app password (needs 2-Step Verification) |
| Fastmail | `smtp.fastmail.com` | 465 | Your address | An app password |
| Resend | `smtp.resend.com` | 465 or 587 | `resend` | Your API key |
| Postmark | `smtp.postmarkapp.com` | 587 | Your server API token | The same token |

Personal mailboxes such as Gmail have daily sending limits and are best for small apps. Transactional services like Resend and Postmark handle more volume and deliver better, once you've verified your domain with them.

## Troubleshooting

| Symptom | What to check |
|---|---|
| The app gets a 500 error when sending (`unexpected_failure`, "Error sending email") | The mail server refused the email. The `keel-auth` log has a "failed to send" line with the reason, often a wrong password or an unverified sender. |
| Links point at `localhost` | Set `KEEL_PUBLIC_URL` to your server's address and run `./keel up`. |
| Links open the wrong page | Set the Site URL, and make sure `redirectTo` is allowed. |
| `over_email_send_rate_limit` | Wait a minute between emails of the same kind; at most 6 per address and 100 per project per hour. |
| Nothing arrives, no error | Look in the spam folder, and check SPF and DKIM for the sender's domain. |
