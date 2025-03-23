import spacy
import json

# Load SpaCy's English model
nlp = spacy.load("en_core_web_sm")

# List of transcripts
transcripts = [
    "Hi, I'd like to order two cheeseburgers and one large fries. Can you also add a Coke?",
    "Can I get three pepperoni pizzas and one vegetarian pizza, please?",
    "I need one chicken sandwich combo with medium fries and a Sprite.",
    "Please send me two chocolate milkshakes and one vanilla milkshake.",
    "I'd like four burgers, two with extra cheese and two without onions, along with three large fries.",
    "Can you add one margherita pizza and a bottle of water to my order?",
    "I want three tacos, one beef, one chicken, and one vegetarian, with extra salsa.",
    "Give me two pasta dishes—one Alfredo and one marinara—and a garlic bread.",
    "I'd like to order five samosas and two bottles of lemonade.",
    "Can I get one large pepperoni pizza with extra olives and a side of garlic knots?"
]

def extract_special_request(token):
    """
    Extract special requests associated with a food item token.
    This includes adjectives, prepositional phrases, and descriptors.
    """
    special_request_parts = []
    for child in token.children:
        if child.dep_ in {"amod", "prep", "pobj", "advmod", "conj"}:  # Adjectives, prepositions, conjunctions
            special_request_parts.append(child.text)
        if child.dep_ == "prep":  # Handle nested prepositions (e.g., "with extra cheese")
            for grandchild in child.children:
                if grandchild.dep_ in {"pobj", "amod"}:
                    special_request_parts.append(f"{child.text} {grandchild.text}")
    return " ".join(special_request_parts)

def process_transcript(transcript):
    """
    Process a single transcript and extract structured order information.
    """
    doc = nlp(transcript)
    annotations = {"transcript": transcript, "order": []}
    quantity = None

    for token in doc:
        if token.like_num:  # Numbers (quantities)
            quantity = token.text
        elif token.ent_type_ in {"FOOD", "PRODUCT"} or token.pos_ == "NOUN":  # Items
            item = token.text
            special_request = extract_special_request(token)
            
            # Add the extracted data to the annotations
            order_entry = {"item": item, "quantity": quantity}
            if special_request:
                order_entry["special_request"] = special_request
            annotations["order"].append(order_entry)
            
            # Reset quantity after pairing
            quantity = None

    return annotations

# Process all transcripts
all_annotations = [process_transcript(transcript) for transcript in transcripts]

# Save to a JSON file
with open("optimized_annotations.json", "w") as f:
    json.dump(all_annotations, f, indent=4)

# Print the structured output for verification
print(json.dumps(all_annotations, indent=4))
