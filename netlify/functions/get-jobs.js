// netlify/functions/get-jobs.js
export async function handler() {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  const jobs = [
    {
      "Functietitel": "Junior Digital Marketeer",
      "Vacature ID": "a0w7R00000JKUieQAH",
      "Headerafbeelding": "https://images.unsplash.com/photo-1519389950473-47ba0277781c",
      "Logo bedrijf": "https://upload.wikimedia.org/wikipedia/commons/a/ab/Logo_TV_2015.png",
      "Slug": "junior-digital-marketeer",
      "Locatie": "Amsterdam"
    },
    {
      "Functietitel": "Marketing & Communicatie Lead",
      "Vacature ID": "a0w7R00000JKUieQAI",
      "Headerafbeelding": "https://images.unsplash.com/photo-1557804506-669a67965ba0",
      "Logo bedrijf": "https://upload.wikimedia.org/wikipedia/commons/c/c5/Logo_example.svg",
      "Slug": "marketing-communicatie-lead",
      "Locatie": "Rotterdam"
    },
    {
      "Functietitel": "Senior Webdesigner",
      "Vacature ID": "a0w7R00000JKUieQAJ",
      "Headerafbeelding": "https://images.unsplash.com/photo-1515378791036-0648a3ef77b2",
      "Logo bedrijf": "https://upload.wikimedia.org/wikipedia/commons/3/3f/Logo_example.png",
      "Slug": "senior-webdesigner",
      "Locatie": "Utrecht"
    }
  ];

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(jobs),
  };
}
