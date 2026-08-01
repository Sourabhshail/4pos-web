using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.FileProviders;

var contentRoot = Directory.GetCurrentDirectory();
var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = contentRoot,
    WebRootPath = contentRoot,
});

LoadEnvFile(Path.Combine(contentRoot, "razorpay.env"));

var keyId = Environment.GetEnvironmentVariable("RAZORPAY_KEY_ID") ?? "";
var keySecret = Environment.GetEnvironmentVariable("RAZORPAY_KEY_SECRET") ?? "";

builder.Services.AddHttpClient("razorpay", client =>
{
    client.BaseAddress = new Uri("https://api.razorpay.com/v1/");
    client.Timeout = TimeSpan.FromSeconds(30);
    if (KeysConfigured(keyId, keySecret))
    {
        var token = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{keyId}:{keySecret}"));
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Basic", token);
    }
});

builder.Services.AddCors(options =>
{
    options.AddDefaultPolicy(policy =>
        policy.AllowAnyOrigin().AllowAnyMethod().AllowAnyHeader());
});

var app = builder.Build();
app.UseCors();

app.Use(async (context, next) =>
{
    var path = context.Request.Path.Value ?? "";
    if (IsBlockedPath(path))
    {
        context.Response.StatusCode = StatusCodes.Status404NotFound;
        return;
    }

    await next();
});

var defaultFiles = new DefaultFilesOptions
{
    FileProvider = new PhysicalFileProvider(contentRoot),
};
defaultFiles.DefaultFileNames.Clear();
defaultFiles.DefaultFileNames.Add("index.html");
app.UseDefaultFiles(defaultFiles);

app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(contentRoot),
});

var jsonOptions = new JsonSerializerOptions
{
    PropertyNameCaseInsensitive = true,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
};

app.MapPost("/api/razorpay/create-order", async (HttpRequest request, IHttpClientFactory httpClientFactory) =>
{
    CreateOrderRequest? body;
    try
    {
        body = await JsonSerializer.DeserializeAsync<CreateOrderRequest>(request.Body, jsonOptions);
    }
    catch (JsonException ex)
    {
        return Results.Json(new { error = ex.Message }, statusCode: StatusCodes.Status400BadRequest);
    }

    body ??= new CreateOrderRequest();
    var amount = body.Amount;
    var currency = string.IsNullOrWhiteSpace(body.Currency) ? "USD" : body.Currency.Trim().ToUpperInvariant();
    var receipt = string.IsNullOrWhiteSpace(body.Receipt)
        ? $"rcpt_{Convert.ToHexString(RandomNumberGenerator.GetBytes(6)).ToLowerInvariant()}"
        : body.Receipt;
    receipt = receipt.Length > 40 ? receipt[..40] : receipt;
    var planId = string.IsNullOrWhiteSpace(body.PlanId) ? "plan" : body.PlanId;
    var reference = (body.Reference ?? string.Empty);
    if (reference.Length > 120) reference = reference[..120];

    if (amount < 100)
    {
        return Results.Json(
            new { error = "Amount must be at least 100 in the smallest currency unit." },
            statusCode: StatusCodes.Status400BadRequest);
    }

    if (!KeysConfigured(keyId, keySecret))
    {
        return Results.Json(new { error = MissingKeysMessage() }, statusCode: StatusCodes.Status500InternalServerError);
    }

    try
    {
        var client = httpClientFactory.CreateClient("razorpay");
        var payload = new
        {
            amount,
            currency,
            receipt,
            notes = new
            {
                plan_id = planId,
                source = "4pos-website-pricing",
                reference,
            },
        };

        using var response = await client.PostAsJsonAsync("orders", payload);
        var text = await response.Content.ReadAsStringAsync();
        using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(text) ? "{}" : text);

        if (!response.IsSuccessStatusCode)
        {
            return Results.Json(new { error = ExtractRazorpayError(doc) }, statusCode: StatusCodes.Status500InternalServerError);
        }

        var root = doc.RootElement;
        return Results.Json(new
        {
            id = root.GetProperty("id").GetString(),
            amount = root.GetProperty("amount").GetInt64(),
            currency = root.GetProperty("currency").GetString(),
        });
    }
    catch (Exception ex)
    {
        return Results.Json(
            new { error = $"Network error contacting Razorpay: {ex.Message}" },
            statusCode: StatusCodes.Status500InternalServerError);
    }
});

app.MapPost("/api/razorpay/verify-payment", async (HttpRequest request) =>
{
    VerifyPaymentRequest? body;
    try
    {
        body = await JsonSerializer.DeserializeAsync<VerifyPaymentRequest>(request.Body, jsonOptions);
    }
    catch (JsonException ex)
    {
        return Results.Json(new { error = ex.Message, success = false }, statusCode: StatusCodes.Status400BadRequest);
    }

    body ??= new VerifyPaymentRequest();
    var orderId = body.RazorpayOrderId ?? "";
    var paymentId = body.RazorpayPaymentId ?? "";
    var signature = body.RazorpaySignature ?? "";

    if (string.IsNullOrWhiteSpace(orderId) || string.IsNullOrWhiteSpace(paymentId) || string.IsNullOrWhiteSpace(signature))
    {
        return Results.Json(
            new { error = "Missing payment verification fields.", success = false },
            statusCode: StatusCodes.Status400BadRequest);
    }

    if (!KeysConfigured(keyId, keySecret))
    {
        return Results.Json(
            new { error = MissingKeysMessage(), success = false },
            statusCode: StatusCodes.Status500InternalServerError);
    }

    var expected = ComputeHmacSha256Hex(keySecret, $"{orderId}|{paymentId}");
    if (!FixedTimeEqualsHex(expected, signature))
    {
        return Results.Json(
            new { error = "Invalid payment signature.", success = false },
            statusCode: StatusCodes.Status400BadRequest);
    }

    return Results.Json(new { success = true, payment_id = paymentId });
});

if (!KeysConfigured(keyId, keySecret))
{
    app.Logger.LogWarning("Razorpay keys missing. Add razorpay.env next to the app and recycle the IIS app pool.");
}
else
{
    app.Logger.LogInformation("Razorpay keys loaded.");
}

app.Run();

static string ExtractRazorpayError(JsonDocument doc)
{
    if (!doc.RootElement.TryGetProperty("error", out var error))
    {
        return "Razorpay API request failed";
    }

    if (error.ValueKind == JsonValueKind.Object)
    {
        if (error.TryGetProperty("description", out var description) && description.ValueKind == JsonValueKind.String)
        {
            return description.GetString() ?? "Razorpay API request failed";
        }

        if (error.TryGetProperty("reason", out var reason) && reason.ValueKind == JsonValueKind.String)
        {
            return reason.GetString() ?? "Razorpay API request failed";
        }
    }

    if (error.ValueKind == JsonValueKind.String)
    {
        return error.GetString() ?? "Razorpay API request failed";
    }

    return "Razorpay API request failed";
}

static string ComputeHmacSha256Hex(string secret, string payload)
{
    var key = Encoding.UTF8.GetBytes(secret);
    var data = Encoding.UTF8.GetBytes(payload);
    var hash = HMACSHA256.HashData(key, data);
    return Convert.ToHexString(hash).ToLowerInvariant();
}

static bool FixedTimeEqualsHex(string expectedHex, string actual)
{
    var expectedBytes = Encoding.UTF8.GetBytes(expectedHex);
    var actualBytes = Encoding.UTF8.GetBytes(actual);
    return expectedBytes.Length == actualBytes.Length
        && CryptographicOperations.FixedTimeEquals(expectedBytes, actualBytes);
}

static bool KeysConfigured(string keyId, string keySecret)
{
    if (string.IsNullOrWhiteSpace(keyId) || string.IsNullOrWhiteSpace(keySecret)) return false;

    string[] placeholders = ["", "your_key_secret", "your_secret_here", "PASTE_YOUR_KEY_SECRET_HERE"];
    if (placeholders.Contains(keyId) || placeholders.Contains(keySecret)) return false;
    if (keyId.Contains("REPLACE", StringComparison.Ordinal) || keySecret.Contains("PASTE_", StringComparison.Ordinal))
    {
        return false;
    }

    return true;
}

static string MissingKeysMessage() =>
    "Razorpay Key Secret is missing. Open razorpay.env in the site folder " +
    "and paste your Key Secret from https://dashboard.razorpay.com/app/keys " +
    "(same page as your Key ID), then recycle the IIS app pool.";

static void LoadEnvFile(string path)
{
    if (!File.Exists(path)) return;

    foreach (var raw in File.ReadLines(path))
    {
        var line = raw.Trim();
        if (string.IsNullOrEmpty(line) || line.StartsWith('#') || !line.Contains('=')) continue;

        var eq = line.IndexOf('=');
        var key = line[..eq].Trim();
        var value = line[(eq + 1)..].Trim();
        if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable(key)))
        {
            Environment.SetEnvironmentVariable(key, value);
        }
    }
}

static bool IsBlockedPath(string path)
{
    var normalized = path.Replace('\\', '/').ToLowerInvariant();
    return normalized.Contains("/razorpay.env")
        || normalized.EndsWith(".env")
        || normalized.EndsWith(".cs")
        || normalized.EndsWith(".csproj")
        || normalized.EndsWith(".user")
        || normalized.EndsWith(".cmd")
        || normalized.Contains("/bin/")
        || normalized.Contains("/obj/")
        || normalized.Contains("/.git/");
}

sealed class CreateOrderRequest
{
    [JsonPropertyName("amount")]
    public int Amount { get; set; }

    [JsonPropertyName("currency")]
    public string? Currency { get; set; }

    [JsonPropertyName("receipt")]
    public string? Receipt { get; set; }

    [JsonPropertyName("planId")]
    public string? PlanId { get; set; }

    [JsonPropertyName("reference")]
    public string? Reference { get; set; }
}

sealed class VerifyPaymentRequest
{
    [JsonPropertyName("razorpay_order_id")]
    public string? RazorpayOrderId { get; set; }

    [JsonPropertyName("razorpay_payment_id")]
    public string? RazorpayPaymentId { get; set; }

    [JsonPropertyName("razorpay_signature")]
    public string? RazorpaySignature { get; set; }
}
