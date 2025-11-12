export async function handler() {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
  };

  const jobs = [
    {
      id: "a0w7R00000JKUieQAH",
      title: "Junior Digital Marketeer",
      description: "Junior marketeer verantwoordelijk voor online campagnes en SEO.",
      image: "https://images.unsplash.com/photo-1519389950473-47ba0277781c",
      companyLogo: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Logo_TV_2015.png",
      slug: "junior-digital-marketeer",
      location: "Amsterdam"
    },
    {
      id: "a0w7R00000JKUieQAI",
      title: "Marketing & Communicatie Lead",
      description: "Leid onze content- en marketingstrategie binnen het team.",
      image: "https://images.unsplash.com/photo-1557804506-669a67965ba0",
      companyLogo: "https://upload.wikimedia.org/wikipedia/commons/c/c5/Logo_example.svg",
      slug: "marketing-communicatie-lead",
      location: "Rotterdam"
    },
    {
      id: "a0w7R00000JKUieQAJ",
      title: "Senior Webdesigner",
      description: "Ervaren webdesigner met focus op UX en visuele identiteit.",
      image: "https://images.unsplash.com/photo-1515378791036-0648a3ef77b2",
      companyLogo: "https://upload.wikimedia.org/wikipedia/commons/3/3f/Logo_example.png",
      slug: "senior-webdesigner",
      location: "Utrecht"
    }
  ];

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify(jobs),
  };
}
